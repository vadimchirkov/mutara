// Recipe 3: cost-down — tune a cheap model, then gate both cheap arms against the
// expensive production setup on fresh cases. Wiring demo with stub models.
// For a real measurement with prices and resume, see examples/cost-down/run.mjs.
//
// Optional host module (`node examples/vercel-ai/cost-down.mjs ./executor.mjs`)
// exports { expensive: { generateText, model, params }, cheap: {...}, reflect? }.
// This proves plumbing (tune naive vs optimized arms), not a measured saving.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { optimizeReflective } from "teob-mutara/reflective";
import { gate } from "teob-mutara/gate";
import { createTextRunner, exactScore } from "../../skills/mutara/assets/vercel-ai.mjs";

const PRODUCTION_PROMPT = "Classify the message.";
const MARGIN = 0.1; // demo margin: needs ~60 fresh pairs. Production 0.03-0.05 needs 120-200.
const texts = Array.from({ length: 8 }, (_, i) => ({ text: `msg-${i}`, expected: i % 2 ? "yes" : "no" }));
const cases = [
  ...texts.slice(0, 4).map((c, i) => ({ id: `train-${i}`, split: "train", input: { text: c.text }, expected: c.expected })),
  ...texts.slice(4).map((c, i) => ({ id: `validation-${i}`, split: "validation", input: { text: c.text }, expected: c.expected })),
];
const fresh = Array.from({ length: 80 }, (_, i) => ({
  id: `fresh-${i}`, input: { text: `fresh-msg-${i}` }, expected: i % 2 ? "yes" : "no",
}));
const byText = new Map([...texts, ...fresh.map((c) => ({ text: c.input.text, expected: c.expected }))].map((c) => [c.text, c.expected]));

const host = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href))
  : null;
// Stubs: the expensive model is always right; the cheap one only once tuned.
const stubExpensive = async ({ prompt }) => ({
  text: byText.get(prompt), usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});
const stubCheap = async ({ system, prompt }) => ({
  text: String(system).includes("Be precise.") ? byText.get(prompt) : "no",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});
const expensive = host?.expensive ?? { generateText: stubExpensive, model: "stub-expensive", params: { temperature: 0 } };
const cheap = host?.cheap ?? { generateText: stubCheap, model: "stub-cheap", params: { temperature: 0 } };
const recovery = host ? "manual" : "repeatable";

const storage = join(mkdtempSync(join(tmpdir(), "mutara-vercel-costdown-")), "learning.db");
const implementation = {
  task: "vercel-cost-down-v1", reflector: "stub-append-v1", evaluator: "exact-v1", margin: MARGIN,
  models: { expensive: expensive.model.modelId ?? expensive.model, cheap: cheap.model.modelId ?? cheap.model },
};

// 1. Tune the production prompt for the cheap model on train/validation only.
const tuned = await optimizeReflective({
  id: "vercel-cost-down-tune-v1",
  storage,
  implementation,
  initialPrompt: PRODUCTION_PROMPT,
  objective: "Classify yes/no exactly like the production setup.",
  cases,
  run: createTextRunner({ generateText: cheap.generateText, model: cheap.model, params: cheap.params }),
  score: (receipt, c) => exactScore(receipt.output, c.expected),
  reflect: host?.reflect ?? (async ({ parentPrompt }) => ({
    text: parentPrompt.includes("Be precise.") ? `${parentPrompt}!` : `${parentPrompt} Be precise.`,
    cost: 0,
  })),
  recovery,
  rounds: 3,
  costLimit: 1000,
  reflectionCostLimit: 0,
  budget: { cost: 1_000_000 },
});

// 2. Gate both cheap arms against the expensive production setup on fresh cases.
const arm = (id, prompt) => gate({
  id,
  storage,
  implementation: { ...implementation, prompt },
  cases: fresh,
  baseline: createTextRunner({ generateText: expensive.generateText, model: expensive.model, params: expensive.params })
    .bind(null, PRODUCTION_PROMPT),
  candidate: createTextRunner({ generateText: cheap.generateText, model: cheap.model, params: cheap.params })
    .bind(null, prompt),
  score: (output, c) => exactScore(output, c.expected),
  scoreRange: 1,
  minimumGain: -MARGIN,
  recovery,
});
const naive = await arm("vercel-cost-down-naive-v1", PRODUCTION_PROMPT);
const optimized = await arm("vercel-cost-down-optimized-v1", tuned.champion);

if (!host) {
  assert.equal(naive.verdict, "reject"); // untuned cheap is 0.5 vs 1.0: outside the margin
  assert.equal(optimized.verdict, "promote"); // tuned cheap matches: within the margin
  const regated = await arm("vercel-cost-down-optimized-v1", tuned.champion);
  assert.equal(regated.verdict, optimized.verdict); // journal replay, no new calls
}

console.log(JSON.stringify({
  tuned: tuned.champion,
  accepted: tuned.history.map((h) => h.accepted),
  naive: { verdict: naive.verdict, cases: naive.cases, candidate: naive.candidate.mean, baseline: naive.baseline.mean },
  optimized: { verdict: optimized.verdict, cases: optimized.cases, candidate: optimized.candidate.mean, baseline: optimized.baseline.mean },
  note: host ? "Host executors; ship only on promote with a predeclared margin." : "Stub wiring demo; not a measured saving.",
}, null, 2));
