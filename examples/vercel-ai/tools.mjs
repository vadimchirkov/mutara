// Recipe 4: tool-calling agent — the model must pick the right tool with the
// right args. Wiring demo: stub `generateText` with the same shape, no API keys,
// no `ai` dependency. Pass an executor module to run against a real model:
//   node examples/vercel-ai/tools.mjs ./my-executor.mjs
// where the module exports { generateText, model, params, tools }.
// This proves plumbing (tune -> gate -> resume), not a measured gain.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { optimizeReflective } from "teob-mutara/reflective";
import { gate } from "teob-mutara/gate";
import { calledTool, toolCallsOf, toolSequence, usageCost } from "../../skills/mutara/assets/vercel-ai.mjs";

const TOOLS = ["get_weather", "get_time"];
const toolOf = (text) => (String(text).includes("weather") ? "get_weather" : "get_time");
const cityOf = (text) => String(text).match(/in ([A-Za-z]+)/)?.[1] ?? "?";
const cases = [];
for (const split of ["train", "validation"]) {
  ["weather in Brooklyn", "weather in Paris", "time in Berlin", "time in Tokyo"].forEach((text, i) => {
    cases.push({ id: `${split}-${i}`, split, input: { text }, expected: { tool: toolOf(text), city: cityOf(text) } });
  });
}
const fresh = Array.from({ length: 40 }, (_, i) => {
  const text = i % 2 ? `weather in City${i}` : `time in City${i}`;
  return { id: `fresh-${i}`, input: { text }, expected: { tool: toolOf(text), city: cityOf(text) } };
});

const host = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href))
  : null;
// Stub: emits the right tool call iff the system names that tool; otherwise answers bare.
const stubGenerateText = async ({ system, prompt }) => {
  const tool = toolOf(prompt);
  const result = String(system).includes(tool)
    ? { text: "done", toolCalls: [{ toolName: tool, args: { city: cityOf(prompt) } }] }
    : { text: "I cannot help with that.", toolCalls: [] };
  return { ...result, usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
};
const generateText = host?.generateText ?? stubGenerateText;
const model = host?.model ?? "stub-model";
const params = host?.params ?? { temperature: 0 };
const tools = host?.tools ?? Object.fromEntries(TOOLS.map((name) => [name, { description: `stub ${name}` }]));

// Tool tasks need structured output: the receipt carries parsed calls, not just text.
const run = async (system, c) => {
  const result = await generateText({ model, system, prompt: c.input.text, tools, ...params });
  if (typeof result?.text !== "string") throw new Error("generateText must resolve { text: string }");
  return { output: { text: result.text, toolCalls: toolCallsOf(result) }, cost: usageCost(result?.usage, 0) };
};
const score = (receipt, c) => {
  const order = toolSequence(receipt.output.toolCalls, [c.expected.tool]);
  if (!order.score) return order;
  return calledTool(receipt.output.toolCalls, c.expected.tool, { args: { city: c.expected.city } });
};

const storage = join(mkdtempSync(join(tmpdir(), "mutara-vercel-tools-")), "learning.db");
const implementation = {
  task: "vercel-tools-v1", reflector: "stub-append-v1", evaluator: "tool-call-v1",
  model: model.modelId ?? model, params, tools: TOOLS,
};
const INITIAL = "Answer the question.";
const options = {
  id: "vercel-tools-v1",
  storage,
  implementation,
  initialPrompt: INITIAL,
  objective: "Call get_weather for weather questions and get_time for time questions, with the city argument.",
  cases,
  run,
  score,
  reflect: host?.reflect ?? (async ({ parentPrompt, failures }) => {
    const missing = TOOLS.find((t) =>
      !parentPrompt.includes(t) &&
      (failures.length === 0 || failures.some((f) => toolOf(f.input.text) === t)));
    return { text: missing ? `${parentPrompt} Use ${missing}.` : `${parentPrompt}!`, cost: 0 };
  }),
  recovery: host ? "manual" : "repeatable",
  rounds: 4,
  costLimit: 1000,
  reflectionCostLimit: 0,
  budget: { cost: 1_000_000 },
};

const tuned = await optimizeReflective(options);
if (!host) {
  for (const t of TOOLS) assert.match(tuned.champion, new RegExp(t));
  assert(tuned.history.some((h) => h.accepted));
}

const wrap = (system) => async (c) => run(system, { input: c.input });
const gateOpts = (id, candidate) => ({
  id,
  storage,
  implementation: { ...implementation, baseline: INITIAL, candidate },
  cases: fresh,
  baseline: wrap(INITIAL),
  candidate: wrap(candidate),
  score: (output, c) => score({ output }, c), // gate passes receipt.output, not the receipt
  scoreRange: 1,
  recovery: host ? "manual" : "repeatable",
});
const gated = await gate(gateOpts("vercel-tools-gate-v1", tuned.champion));
await optimizeReflective(options);
const regated = await gate(gateOpts("vercel-tools-gate-v1", tuned.champion));
assert.equal(regated.verdict, gated.verdict);

console.log(JSON.stringify({
  before: tuned.initial,
  after: tuned.champion,
  accepted: tuned.history.map((h) => h.accepted),
  gate: { verdict: gated.verdict, cases: gated.cases, baseline: gated.baseline.mean, candidate: gated.candidate.mean },
  executions: tuned.executions,
  cost: tuned.spent,
  note: host ? "Host executor; report the gate verdict, not journal growth." : "Stub wiring demo; not a measured gain.",
}, null, 2));
