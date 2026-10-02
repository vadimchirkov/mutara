// Recipe 2: intent router (cancel vs other) with a hard false-positive gate.
// Wiring demo: stub `generateText` with the same shape, no API keys, no `ai`
// dependency. Pass an executor module to run against a real model:
//   node examples/vercel-ai/router.mjs ./my-executor.mjs
// where the module exports { generateText, model, params }.
// This proves plumbing (tune -> gate -> resume), not a measured gain.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { optimizeReflective } from "teob-mutara/reflective";
import { gate } from "teob-mutara/gate";
import { createTextRunner } from "../../skills/mutara/assets/vercel-ai.mjs";

const topics = ["alpha", "beta"];
const cases = [];
for (const split of ["train", "validation"]) {
  topics.forEach((topic, i) => {
    cases.push({ id: `${split}-yes-${i}`, split, input: { text: `topic:${topic} msg-${split}-${i}` }, expected: "cancel" });
    cases.push({ id: `${split}-no-${i}`, split, input: { text: `topic:other-${split}-${i}` }, expected: "other" });
  });
}
const fresh = Array.from({ length: 20 }, (_, i) => [
  { id: `fresh-yes-${i}`, input: { text: `topic:${topics[i % topics.length]} fresh-${i}` }, expected: "cancel" },
  { id: `fresh-no-${i}`, input: { text: `topic:other-fresh-${i}` }, expected: "other" },
]).flat();

// Cancellations the stub invents beyond the prompt's keywords are the hard-rule
// violation: a candidate that cancels "other" must never promote, even if its
// raw accuracy is higher. Mirrors examples/prompt-gate/adapter.mjs:76.
function routerScore(output, expected) {
  const accuracy = Number(output === expected);
  const falseCancellation = Number(output === "cancel" && expected === "other");
  return {
    score: accuracy,
    violation: falseCancellation,
    feedback: accuracy ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`,
  };
}

const host = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href))
  : null;
// Stub `generateText({ system, prompt })`: cancel iff the system names the input topic.
const stubGenerateText = async ({ system, prompt }) => {
  const m = String(prompt).match(/topic:([a-z-]+)/);
  const topic = m?.[1] ?? "";
  const output = topic.startsWith("other")
    ? "other"
    : (topic && String(system).includes(topic) ? "cancel" : "other");
  return { text: output, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
};
const generateText = host?.generateText ?? stubGenerateText;
const model = host?.model ?? "stub-model";
const params = host?.params ?? { temperature: 0 };

const storage = join(mkdtempSync(join(tmpdir(), "mutara-vercel-router-")), "learning.db");
const implementation = { task: "vercel-router-v1", reflector: "stub-append-v1", evaluator: "accuracy-falsecancel-v1", model: model.modelId ?? model, params };

const run = createTextRunner({ generateText, model, params });
const options = {
  id: "vercel-router-v1",
  storage,
  implementation,
  initialPrompt: "Return cancel or other.",
  objective: "Cancel only explicit alpha/beta requests; policy questions, negations and other topics are other.",
  cases,
  run,
  score: (receipt, c) => routerScore(receipt.output, c.expected),
  reflect: host?.reflect ?? (async ({ parentPrompt, failures }) => {
    const missing = topics.find((t) =>
      !parentPrompt.includes(t) &&
      (failures.length === 0 || failures.some((f) => String(f.input.text).includes(t))));
    return { text: missing ? `${parentPrompt} ${missing}` : `${parentPrompt}!`, cost: 0 };
  }),
  recovery: host ? "manual" : "repeatable",
  rounds: 3,
  costLimit: 1000,
  reflectionCostLimit: 0,
  budget: { cost: 1_000_000 },
};

const tuned = await optimizeReflective(options);
if (!host) {
  assert.equal(tuned.champion, "Return cancel or other. alpha beta");
  assert.deepEqual(tuned.history.map((h) => h.accepted), [true, true]);
}

// Gate champion vs initial on fresh cases the search never saw.
const wrap = (system) => {
  const r = createTextRunner({ generateText, model, params });
  return async (c) => r(system, { input: c.input });
};
const gateOpts = (id, candidate) => ({
  id,
  storage,
  implementation: { ...implementation, baseline: "Return cancel or other.", candidate },
  cases: fresh,
  baseline: wrap("Return cancel or other."),
  candidate: wrap(candidate),
  score: (output, c) => routerScore(output, c.expected),
  scoreRange: 1,
  recovery: host ? "manual" : "repeatable",
});
const gated = await gate(gateOpts("vercel-router-gate-v1", tuned.champion));

// Resume costs nothing new: same ids replay from the journal.
await optimizeReflective(options);
const regated = await gate(gateOpts("vercel-router-gate-v1", tuned.champion));
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
