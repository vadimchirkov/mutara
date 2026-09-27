// Reflective prompt optimization on the payment-extraction task with a real model.
//
//   MUTARA_LLM_BASE_URL=https://api.openai.com/v1 MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... \
//     node examples/reflective-bench/run.mjs NEW_REPORT_DIRECTORY [--rounds N] [--dry]
//
// Optional: MUTARA_REFLECT_MODEL (default: the task model), MUTARA_LLM_TEMPERATURE (default 0).
// Re-running with the same directory resumes from the journal without repeating finished calls.
// `--dry` swaps the model for a scripted stub: it checks wiring and measures nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReflectionPrompt, optimizeReflective } from "teob-mutara/reflective";
import { chatClient } from "./llm.mjs";
import { INITIAL_PROMPT, OBJECTIVE, dataset, grade } from "./task.mjs";

const args = process.argv.slice(2);
const directory = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--rounds");
if (!directory) throw new Error("Usage: node examples/reflective-bench/run.mjs NEW_REPORT_DIRECTORY [--rounds N] [--dry]");
const dry = args.includes("--dry");
const rounds = args.includes("--rounds") ? Number(args[args.indexOf("--rounds") + 1]) : 8;

const env = process.env;
const taskModel = dry ? "dry-stub" : env.MUTARA_LLM_MODEL;
const reflectModel = dry ? "dry-stub" : env.MUTARA_REFLECT_MODEL || taskModel;
const temperature = Number(env.MUTARA_LLM_TEMPERATURE ?? 0);
const stub = async (messages) => ({
  text: messages.length === 1 ? `${messages[0].content.match(/<prompt>\n([\s\S]*?)\n<\/prompt>/)[1]} Be precise.` : '{"amount":"0"}',
  tokens: 50, ms: 0,
});
const task = dry ? stub : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model: taskModel, temperature, maxTokens: 300 });
const reflector = dry ? stub : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model: reflectModel, temperature: 0.7, maxTokens: 2000 });

const latency = { task: [], reflect: [] };
const { cases, finalCases } = dataset();
const byId = new Map([...cases, ...finalCases].map((c) => [c.id, c]));
const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

mkdirSync(resolve(directory), { recursive: true });
const started = performance.now();
const result = await optimizeReflective({
  id: `payments-${taskModel}-v1`,
  storage: join(resolve(directory), "bench.db"),
  // Pins everything that shapes behaviour. Never the API key.
  implementation: { task: source("task.mjs"), llm: source("llm.mjs"), run: source("run.mjs"), taskModel, reflectModel, temperature },
  initialPrompt: INITIAL_PROMPT,
  objective: OBJECTIVE,
  cases,
  finalCases,
  run: async (prompt, c) => {
    const reply = await task([{ role: "system", content: prompt }, { role: "user", content: c.input.text }]);
    latency.task.push(reply.ms);
    return { output: reply.text, cost: reply.tokens };
  },
  score: (receipt, c) => grade(receipt.output, byId.get(c.id).expected),
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const reply = await reflector([{ role: "user", content: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) }]);
    latency.reflect.push(reply.ms);
    return { text: reply.text.replace(/^```\w*\n?|\n?```$/g, "").trim(), cost: reply.tokens };
  },
  rounds,
  maxPromptChars: 6000,
  costLimit: 4000,
  reflectionCostLimit: 16000,
  budget: { cost: 2_000_000 },
  recovery: "repeatable",
  finalTest: { scoreRange: 1 },
});

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const report = {
  note: dry ? "Dry run with a scripted stub: wiring only, not a measurement." : "Measured on generated cases; see README for caveats.",
  taskModel, reflectModel, temperature,
  finalAudit: result.finalAudit,
  initial: result.initial,
  champion: result.champion,
  rounds: result.history.map((h) => ({ round: h.round, screened: h.screened, evaluated: h.evaluated, accepted: h.accepted,
    train: [h.train.baselineMean, h.train.candidateMean], validation: [h.validation.baselineMean, h.validation.candidateMean] })),
  stopReason: result.stopReason,
  tokens: result.spent,
  executions: result.executions,
  // Calls made by this process only; a resumed run replays journaled calls without latency.
  wallSeconds: Math.round((performance.now() - started) / 1000),
  meanLatencyMs: { task: mean(latency.task), reflect: mean(latency.reflect) },
  callsThisProcess: { task: latency.task.length, reflect: latency.reflect.length },
};
writeFileSync(join(resolve(directory), "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
