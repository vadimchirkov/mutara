// Reflective prompt optimization on the payment-extraction task with a real model.
//
//   MUTARA_LLM_BASE_URL=https://api.openai.com/v1 MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... \
//     node examples/reflective-bench/run.mjs NEW_REPORT_DIRECTORY [options]
//
// Options: --rounds N (8), --task easy|hard (easy), --feedback full|none (full: the reflector
// also sees evaluator feedback), --strategy champion|pareto (champion), --components (one
// prompt component per field instead of one prompt), --merges N (0), --concurrency N (1: task
// calls in flight at once; results do not depend on it), --dry.
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
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--rounds", "--task", "--feedback", "--strategy", "--merges", "--concurrency"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/reflective-bench/run.mjs NEW_REPORT_DIRECTORY [options]");
const dry = args.includes("--dry");
const components = args.includes("--components");
const config = {
  task: flag("--task", "easy"),
  feedback: flag("--feedback", "full"),
  strategy: flag("--strategy", "champion"),
  components,
  merges: Number(flag("--merges", 0)),
  rounds: Number(flag("--rounds", 8)),
};
if (!["easy", "hard"].includes(config.task) || !["full", "none"].includes(config.feedback)) throw new Error("Invalid --task or --feedback");

const env = process.env;
const taskModel = dry ? "dry-stub" : env.MUTARA_LLM_MODEL;
const reflectModel = dry ? "dry-stub" : env.MUTARA_REFLECT_MODEL || taskModel;
const temperature = Number(env.MUTARA_LLM_TEMPERATURE ?? 0);
const stub = async (messages) => ({
  text: messages.length === 1 ? `${messages[0].content.match(/<prompt>\n([\s\S]*?)\n<\/prompt>/)[1]} Be precise.` : '{"amount":"0"}',
  tokens: 50, ms: 0,
});
const task = dry ? stub : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model: taskModel, temperature, maxTokens: 2000 });
const reflector = dry ? stub : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model: reflectModel, temperature: 0.7, maxTokens: 8000 });

const latency = { task: [], reflect: [] };
const { cases, finalCases } = dataset(config.task);
// Component mode: one instruction per output field, assembled under a fixed header.
const HEADER = "Extract the payment from the message. Reply with JSON with keys amount, currency, date, vendor.";
const initialPrompt = components
  ? { amount: "amount: the amount paid.", currency: "currency: the currency.", date: "date: the payment date.", vendor: "vendor: who was paid." }
  : INITIAL_PROMPT;
const systemOf = (prompt) => typeof prompt === "string" ? prompt
  : `${HEADER}\n\nField instructions:\n${Object.keys(prompt).sort().map((k) => prompt[k]).join("\n\n")}`;
const byId = new Map([...cases, ...finalCases].map((c) => [c.id, c]));
const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

mkdirSync(resolve(directory), { recursive: true });
const started = performance.now();
const result = await optimizeReflective({
  id: config.task === "easy" && config.feedback === "full" && config.strategy === "champion" && !components && !config.merges
    ? `payments-${taskModel}-v1`
    : `payments-${config.task}-${config.feedback}-${config.strategy}-${components ? "components" : "single"}-m${config.merges}-${taskModel}-v1`,
  storage: join(resolve(directory), "bench.db"),
  concurrency: Number(flag("--concurrency", 1)),
  // Pins everything that shapes behaviour. Never the API key.
  implementation: { task: source("task.mjs"), llm: source("llm.mjs"), run: source("run.mjs"), taskModel, reflectModel, temperature },
  initialPrompt,
  objective: OBJECTIVE,
  cases,
  finalCases,
  run: async (prompt, c) => {
    const reply = await task([{ role: "system", content: systemOf(prompt) }, { role: "user", content: c.input.text }]);
    latency.task.push(reply.ms);
    // The model's reasoning is the execution trace the reflector learns from (GEPA's traces).
    return { output: reply.text, cost: reply.tokens, ...(reply.reasoning ? { trace: reply.reasoning } : {}) };
  },
  score: (receipt, c) => grade(receipt.output, byId.get(c.id).expected),
  reflect: async ({ objective, component, parentPrompt, parentSystem, failures, parentScores }) => {
    const shown = config.feedback === "none" ? failures.map(({ feedback, ...rest }) => rest) : failures;
    const context = components ? { component, system: parentSystem } : undefined;
    const reply = await reflector([{ role: "user", content: buildReflectionPrompt(objective, parentPrompt, shown, parentScores, context) }]);
    latency.reflect.push(reply.ms);
    return { text: reply.text.replace(/^```\w*\n?|\n?```$/g, "").trim(), cost: reply.tokens };
  },
  rounds: config.rounds,
  parentStrategy: config.strategy,
  maxMerges: config.merges,
  maxPromptChars: 6000,
  costLimit: 6000,
  reflectionCostLimit: 16000,
  budget: { cost: 3_000_000 },
  recovery: "repeatable",
  finalTest: { scoreRange: 1 },
});

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const report = {
  note: dry ? "Dry run with a scripted stub: wiring only, not a measurement." : "Measured on generated cases; see README for caveats.",
  taskModel, reflectModel, temperature, config,
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
