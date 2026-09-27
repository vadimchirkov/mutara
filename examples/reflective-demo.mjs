// Wiring demo for the reflective (GEPA-style) optimizer. Everything is scripted
// and local: a keyword classifier plus a stub reflector that appends one missing
// keyword per round. This proves plumbing (propose → gate → promote → resume),
// not a measured gain on any real task.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeReflective } from "teob-mutara/reflective";

const topics = ["alpha", "beta"];
const cases = [];
for (const split of ["train", "validation"]) {
  topics.forEach((topic, i) => {
    cases.push({ id: `${split}-yes-${i}`, split, input: { topic }, expected: "handled" });
    cases.push({ id: `${split}-no-${i}`, split, input: { topic: `other-${split}-${i}` }, expected: "missed" });
  });
}

const options = {
  id: "reflective-demo-v1",
  storage: join(mkdtempSync(join(tmpdir(), "mutara-reflective-demo-")), "learning.db"),
  implementation: { task: "reflective-demo-v1", reflector: "stub-append-v1" },
  initialPrompt: "base prompt.",
  objective: "Handle alpha and beta topics; miss everything else.",
  cases,
  run: async (prompt, c) => ({
    output: prompt.includes(c.input.topic) ? "handled" : "missed",
    cost: 0,
  }),
  score: (receipt, c) => ({ score: Number(receipt.output === c.expected), violation: 0 }),
  reflect: async ({ parentPrompt, failures }) => {
    const missing = topics.find((t) =>
      !parentPrompt.includes(t) &&
      (failures.length === 0 || failures.some((f) => f.input.topic === t)));
    return { text: missing ? `${parentPrompt} ${missing}` : `${parentPrompt}!`, cost: 0 };
  },
  recovery: "repeatable",
  rounds: 3,
};

const first = await optimizeReflective(options);
assert.equal(first.champion, "base prompt. alpha beta");
assert.deepEqual(first.history.map((h) => h.accepted), [true, true]);
assert.match(first.stopReason, /No train failures/);
const second = await optimizeReflective(options);
assert.deepEqual(second, first);
console.log(JSON.stringify({
  before: first.initial,
  after: first.champion,
  accepted: first.history.map((h) => h.accepted),
  executions: first.executions,
  cost: first.spent,
  note: "Scripted wiring demo; not a measured gain.",
}, null, 2));
