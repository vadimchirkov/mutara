import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gate, gateDecision, type GateOptions } from "../src/gate.js";

const storage = () => join(mkdtempSync(join(tmpdir(), "mutara-gate-")), "gate.db");
const cases = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, input: i }));
// Deterministic per-case accuracy: a side with rate r solves case i when frac(i * golden) < r.
const solves = (rate: number) => async (c: { input: unknown }) => ({ output: ((c.input as number) * 0.6180339887) % 1 < rate, cost: 1 });
const base = (over: Partial<GateOptions>): GateOptions => ({
  id: "g", storage: storage(), implementation: { test: "gate" }, cases,
  baseline: solves(0.7), candidate: solves(0.7), score: (output) => ({ score: Number(output) }), scoreRange: 1, ...over,
});

it("promotes a clearly better candidate and stops early", async () => {
  const r = await gate(base({ candidate: solves(0.95) }));
  expect(r.verdict).toBe("promote");
  expect(r.cases).toBeLessThan(cases.length);
});

it("does not promote an equal candidate for superiority, but does within a non-inferiority margin", async () => {
  expect((await gate(base({}))).verdict).not.toBe("promote");
  expect((await gate(base({ minimumGain: -0.1 }))).verdict).toBe("promote");
});

it("rejects a candidate outside the margin and one that adds violations", async () => {
  expect((await gate(base({ candidate: solves(0.4), minimumGain: -0.1 }))).verdict).toBe("reject");
  const r = await gate(base({ candidate: solves(0.95), score: (output) => ({ score: Number(output), violation: output ? 0 : 1 }),
    baseline: async () => ({ output: true, cost: 1 }) }));
  expect(r.verdict).toBe("reject");
});

it("resumes from the journal without calling the runners again", async () => {
  let calls = 0;
  const counted = (rate: number) => async (c: { input: unknown }) => { calls++; return solves(rate)(c); };
  const options = base({ baseline: counted(0.7), candidate: counted(0.95) });
  const first = await gate(options);
  const made = calls;
  expect(await gate(options)).toEqual(first);
  expect(calls).toBe(made);
});

it("keeps the false-promotion rate at alpha when the true gain sits exactly on the margin", () => {
  let seed = 7;
  const uniform = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (const minimumGain of [0, -0.05, -0.2]) {
    // Paired 0/1 scores whose mean difference equals minimumGain: baseline ~ Bernoulli(0.7), candidate ~ Bernoulli(0.7 + m).
    let promoted = 0;
    for (let i = 0; i < 200; i++) {
      const d = Array.from({ length: 500 }, () => Number(uniform() < 0.7 + minimumGain) - Number(uniform() < 0.7));
      promoted += Number(gateDecision(d, { scoreRange: 1, minimumGain, alpha: 0.05 }).accepted);
    }
    expect(promoted, `minimumGain=${minimumGain}`).toBeLessThanOrEqual(16); // 0.05 * 200 = 10, plus sampling slack
  }
});
