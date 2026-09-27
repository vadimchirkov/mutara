// One Mutara run on IFBench (GEPA's splits and budget), then a journaled test evaluation.
//
//   MUTARA_LLM_BASE_URL=... MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... \
//     node examples/ifbench/run.mjs NEW_RUN_DIRECTORY [--seed N] [--budget 3593] [--concurrency 8] [--dry]
//
// Optional: MUTARA_REFLECT_MODEL (default: the task model), MUTARA_LLM_TEMPERATURE (default 0.6).
// Budget unit: metric calls (one two-stage rollout scored once) on train + validation, as
// GEPA's max_metric_calls. Reflection calls and the test evaluation are outside it on both
// sides. Re-running with the same directory resumes from the journal.
// `--dry` only labels the report: all.mjs --dry points the endpoint at a stub model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest, validateVersion, version } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { buildReflectionPrompt, optimizeReflective } from "teob-mutara/reflective";
import { chatClient } from "../reflective-bench/llm.mjs";
import { INITIAL_PROMPT, OBJECTIVE, loadSplits, runProgram, scorer } from "./program.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--seed", "--budget", "--concurrency"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/ifbench/run.mjs NEW_RUN_DIRECTORY [options]");
const seed = Number(flag("--seed", 7919));
const budget = Number(flag("--budget", 3593));
const concurrency = Number(flag("--concurrency", 8));
const dry = args.includes("--dry");

const env = process.env;
const taskModel = env.MUTARA_LLM_MODEL;
const reflectModel = env.MUTARA_REFLECT_MODEL || taskModel;
const temperature = Number(env.MUTARA_LLM_TEMPERATURE ?? 0.6);
const client = (model, temperature, maxTokens) =>
  chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model, temperature, maxTokens, timeoutMs: 300_000 });
const task = client(taskModel, temperature, 4000);
const reflector = client(reflectModel, 1.0, 8000);
const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const { train, val, test } = loadSplits();
const rows = new Map([...train, ...val, ...test].map((r) => [r.id, r]));
const checker = scorer();
const id = `ifbench-${taskModel}-s${seed}-b${budget}-v1`;
const storage = join(resolve(directory), "mutara.db");
// Pins everything that shapes behaviour. Never the API key.
const implementation = { program: source("program.mjs"), metric: source("metric.py"), run: source("run.mjs"),
  llm: source("../reflective-bench/llm.mjs"), taskModel, reflectModel, temperature };

/** A rollout scored in place: the checker needs the constraint kwargs, which the model never sees. */
async function rollout(prompts, caseId) {
  const row = rows.get(caseId);
  const { text, tokens } = await runProgram(task, prompts, row.prompt);
  const { score, feedback } = await checker.score(row, text);
  return { response: text, score, feedback, tokens };
}

mkdirSync(resolve(directory), { recursive: true });
const started = performance.now();
const result = await optimizeReflective({
  id, storage, implementation, concurrency,
  initialPrompt: INITIAL_PROMPT,
  objective: OBJECTIVE,
  cases: [...train, ...val].map((r) => ({ id: r.id, split: r.split, input: r.prompt,
    expected: "Every constraint stated in the query is satisfied (see evaluator feedback)." })),
  run: async (prompts, c) => ({ output: await rollout(prompts, c.id), cost: 1 }),
  score: (receipt) => ({ score: receipt.output.score, violation: 0, feedback: receipt.output.feedback }),
  reflect: async ({ objective, component, parentPrompt, parentSystem, failures, parentScores }) => {
    const shown = failures.map(({ actual, ...rest }) => ({ ...rest, actual: actual.response }));
    const reply = await reflector([{ role: "user",
      content: buildReflectionPrompt(objective, parentPrompt, shown, parentScores, { component, system: parentSystem }) }]);
    return { text: reply.text.replace(/^```\w*\n?|\n?```$/g, "").trim(), cost: 0 };
  },
  rounds: 100,
  maxFailures: 3, // GEPA's reflection_minibatch_size
  parentStrategy: "pareto",
  maxMerges: 5, // dspy.GEPA default use_merge=True, max_merge_invocations=5
  maxPromptChars: 8000,
  costLimit: 1,
  reflectionCostLimit: 0,
  budget: { cost: budget },
  recovery: "repeatable",
  seed,
});
const optimizeSeconds = (performance.now() - started) / 1000;

// Test split: initial and champion on every test case, journaled like everything else.
const testImplementation = { role: "ifbench-test-v1", ...implementation };
const implId = digest(testImplementation);
const testPlan = { initial: version({ prompts: INITIAL_PROMPT }, implId), rounds: 1, champion: result.champion };
const sides = ["initial", "champion"];
const h = learnerHarness(storage, {
  implementation: testImplementation, recovery: "repeatable",
  validatePlan: (p) => { if (digest(p) !== digest(testPlan)) throw new Error("Test plan changed; use a new directory"); },
  validateVersion: (v) => validateVersion(v, implId),
  limits: () => ({ executions: 2 * test.length, cost: 2 * test.length }),
  propose: (initial, _history, p) => version({ prompts: p.champion }, implId, initial.id),
  jobs: (initial, champion) => sides.flatMap((side) => test.map((r) => ({ key: `${side}:${r.id}`,
    input: { caseId: r.id, prompts: (side === "initial" ? initial : champion).config.prompts }, costLimit: 1 }))),
  execute: async (job) => ({ output: await rollout(job.input.prompts, job.input.caseId), cost: 1 }),
  grade: (_job, receipt) => ({ metrics: { score: receipt.output.score }, data: null }),
  assess: (runs) => ({ evaluation: Object.fromEntries(sides.map((side) => [side,
    Object.fromEntries(runs.filter((r) => r.job.key.startsWith(`${side}:`)).map((r) => [r.job.input.caseId, r.observation.metrics.score]))])),
  decision: { accepted: false, reason: "Report only" } }),
}, { category: "ifbench-test", concurrency, askTimeoutMs: 24 * 3600_000 });
let scores;
try {
  await h.startOrResume(`${id}/test`, testPlan);
  scores = (await h.wait(`${id}/test`, 24 * 3600_000)).trials[0].evaluation;
} finally { await h.close(); checker.close(); }

const mean = (o) => Object.values(o).reduce((a, b) => a + b, 0) / Object.values(o).length;
const report = {
  system: "mutara",
  note: dry ? "Dry run with a stub model: wiring only, not a measurement." : "Measured; see README for method and caveats.",
  id, taskModel, reflectModel, temperature, seed, budget: { metricCalls: budget }, concurrency,
  initial: INITIAL_PROMPT,
  champion: result.champion,
  metricCalls: result.executions,
  reflectionCalls: result.reflectionCalls,
  stopReason: result.stopReason,
  rounds: result.history.map((r) => ({ round: r.round, kind: r.kind, component: r.component, accepted: r.accepted,
    train: [r.train.baselineMean, r.train.candidateMean], validation: [r.validation.baselineMean, r.validation.candidateMean] })),
  test: Object.fromEntries(sides.map((side) => [side, { mean: mean(scores[side]), cases: Object.keys(scores[side]).length, scores: scores[side] }])),
  // This process only; a resumed run replays journaled calls without spending time on them.
  wallSeconds: { optimize: Math.round(optimizeSeconds), total: Math.round((performance.now() - started) / 1000) },
};
writeFileSync(join(resolve(directory), "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, test: Object.fromEntries(sides.map((s) => [s, report.test[s].mean])) }, null, 2));
