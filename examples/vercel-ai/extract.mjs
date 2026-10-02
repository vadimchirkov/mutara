// Recipe 1: structured extraction to JSON with a format-violation gate.
// Wiring demo: stub `generateText` with the same shape, no API keys, no `ai`
// dependency. Pass an executor module to run against a real model:
//   node examples/vercel-ai/extract.mjs ./my-executor.mjs
// where the module exports { generateText, model, params }.
// This proves plumbing (tune -> gate -> resume), not a measured gain.
// For a measured extraction benchmark see examples/reflective-bench/.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { optimizeReflective } from "teob-mutara/reflective";
import { gate } from "teob-mutara/gate";
import { createTextRunner, jsonFieldsScore } from "../../skills/mutara/assets/vercel-ai.mjs";

// Hidden conventions the initial prompt never states; the reflector learns them
// only from failure feedback. Mirrors examples/reflective-bench/task.mjs.
const CONVENTIONS = ["decimals", "UPPER"];
const PAID = [
  { text: "Paid $12.50 to Acme Ltd on 2024-03-01.", expected: { amount: "12.50", vendor: "ACME" } },
  { text: "Globex LLC invoice settled, €99.00, March 2 2024.", expected: { amount: "99.00", vendor: "GLOBEX" } },
  { text: "Transfer of $7.25 to Initech Inc. went out 2024-03-03.", expected: { amount: "7.25", vendor: "INITECH" } },
  { text: "We were charged £250.00 by Umbrella GmbH, dated 2024-03-04.", expected: { amount: "250.00", vendor: "UMBRELLA" } },
  { text: "Paid $3.99 to Hooli S.A. on 2024-03-05.", expected: { amount: "3.99", vendor: "HOOLI" } },
  { text: "Stark plc invoice settled, $1024.10, March 6 2024.", expected: { amount: "1024.10", vendor: "STARK" } },
];
const cases = [
  ...PAID.slice(0, 3).map((c, i) => ({ id: `train-${i}`, split: "train", input: { text: c.text }, expected: c.expected })),
  ...PAID.slice(3).map((c, i) => ({ id: `validation-${i}`, split: "validation", input: { text: c.text }, expected: c.expected })),
];
const fresh = Array.from({ length: 20 }, (_, i) => {
  const base = PAID[i % PAID.length];
  return { id: `fresh-${i}`, input: { text: `${base.text} Ref ${i}.` }, expected: base.expected };
});

const host = process.argv[2]
  ? (await import(pathToFileURL(resolve(process.argv[2])).href))
  : null;
// Stub: amount has two decimals iff system says "decimals"; vendor is UPPER
// without suffix iff system says "UPPER". Anything else degrades the fields.
const stubGenerateText = async ({ system, prompt }) => {
  const row = PAID.find((c) => String(prompt).includes(c.text)) ?? PAID[0];
  const amount = String(system).includes("decimals")
    ? row.expected.amount
    : row.expected.amount.replace(/0$/, "");
  const vendor = String(system).includes("UPPER")
    ? row.expected.vendor
    : row.expected.vendor.charAt(0) + row.expected.vendor.slice(1).toLowerCase();
  return { text: JSON.stringify({ amount, vendor }), usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
};
const generateText = host?.generateText ?? stubGenerateText;
const model = host?.model ?? "stub-model";
const params = host?.params ?? { temperature: 0 };

const storage = join(mkdtempSync(join(tmpdir(), "mutara-vercel-extract-")), "learning.db");
const implementation = { task: "vercel-extract-v1", reflector: "stub-append-v1", evaluator: "json-fields-v1", model: model.modelId ?? model, params };
const INITIAL = 'Extract the payment. Reply with only JSON {"amount", "vendor"}.';

const run = createTextRunner({ generateText, model, params });
const options = {
  id: "vercel-extract-v1",
  storage,
  implementation,
  initialPrompt: INITIAL,
  objective: "Extract amount with two decimals and vendor UPPER without suffix, as JSON.",
  cases,
  run,
  score: (receipt, c) => jsonFieldsScore(receipt.output, c.expected),
  reflect: host?.reflect ?? (async ({ parentPrompt }) => {
    const missing = CONVENTIONS.find((k) => !parentPrompt.includes(k));
    return { text: missing ? `${parentPrompt} ${missing}` : `${parentPrompt}!`, cost: 0 };
  }),
  recovery: host ? "manual" : "repeatable",
  rounds: 4,
  costLimit: 1000,
  reflectionCostLimit: 0,
  budget: { cost: 1_000_000 },
};

const tuned = await optimizeReflective(options);
if (!host) {
  for (const k of CONVENTIONS) assert.match(tuned.champion, new RegExp(k));
  assert(tuned.history.some((h) => h.accepted));
}

// Gate champion vs initial on fresh cases the search never saw.
const wrap = (system) => {
  const r = createTextRunner({ generateText, model, params });
  return async (c) => r(system, { input: c.input });
};
const gateOpts = (id, candidate) => ({
  id,
  storage,
  implementation: { ...implementation, baseline: INITIAL, candidate },
  cases: fresh,
  baseline: wrap(INITIAL),
  candidate: wrap(candidate),
  score: (output, c) => jsonFieldsScore(output, c.expected),
  scoreRange: 1,
  recovery: host ? "manual" : "repeatable",
});
const gated = await gate(gateOpts("vercel-extract-gate-v1", tuned.champion));
await optimizeReflective(options);
const regated = await gate(gateOpts("vercel-extract-gate-v1", tuned.champion));
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
