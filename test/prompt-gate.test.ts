import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnerHarness } from "../src/sqlite.js";
import { coreId, type BasePlan } from "../src/engine.js";
import { digest, type Identity } from "../src/version.js";
// @ts-ignore — standalone public-package example.
import { createPromptGate, createPromptAudit } from "../examples/prompt-gate/adapter.mjs";
// @ts-ignore — standalone synthetic executor.
import { loadFixture } from "../examples/prompt-gate/fixture.mjs";

const root = new URL("../examples/prompt-gate/", import.meta.url);
const proposals = JSON.parse(readFileSync(new URL("proposals.json", root), "utf8"));
type Scores = { accuracy: number; falseCancellations: number };
type Evaluation = Record<string, { baseline: Scores; candidate: Scores }>;
function fixture(file = "selection.json") {
  return loadFixture(new URL(`fixtures/${file}`, root), proposals);
}
async function run(storage: string, id: string, experiment: any) {
  const h = learnerHarness<Identity, BasePlan<Identity>, Evaluation>(storage, experiment.adapter);
  try {
    const saved = await h.startOrResume(id, experiment.plan);
    experiment.adapter.validatePlan(saved.plan);
    if (saved.coreId !== coreId || saved.adapterId !== digest({
      implementation: experiment.adapter.implementation, recovery: experiment.adapter.recovery,
    })) throw new Error("Recorded implementation changed");
    return await h.wait(id);
  } finally { await h.close(); }
}

it("gates fixed external prompts, audits separately, and reopens both journals without calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mutara-prompt-gate-"));
  const storage = join(dir, "learning.db");
  try {
    const data = fixture();
    let calls = 0;
    const execute = data.executor.execute;
    data.executor.execute = async (input: any, context: any) => {
      expect(Object.keys(input).sort()).toEqual(["prompt", "text"]);
      expect(Object.keys(context).sort()).toEqual(["costLimit", "id"]);
      calls++;
      return execute(input);
    };
    const bundle = { ...proposals, datasets: data.datasets };
    const gate = createPromptGate(bundle, data.executor);
    expect(JSON.stringify(gate)).not.toContain("test-1");
    const selection = await run(storage, "prompts-v1", gate);
    expect(selection.trials.map((t) => t.accepted)).toEqual([false, true]);
    expect(selection.trials[0].evaluation).toMatchObject({
      training: { baseline: { accuracy: 0.5 }, candidate: { accuracy: 1 } },
      validation: { baseline: { accuracy: 0.5 }, candidate: { accuracy: 0.25 } },
    });
    expect(calls).toBe(64);
    expect(await run(storage, "prompts-v1", gate)).toEqual(selection);
    expect(calls).toBe(64);

    // Different proposals cannot silently resume or corrupt the original journal.
    const changed = structuredClone(bundle);
    changed.candidates[0] += " Changed.";
    await expect(run(storage, "prompts-v1", createPromptGate(changed, data.executor)))
      .rejects.toThrow(/changed/);
    expect(await run(storage, "prompts-v1", gate)).toEqual(selection);

    const final = fixture("test.json");
    expect(() => createPromptAudit({ ...selection, status: "running" }, final.datasets.test, final.executor))
      .toThrow("Finish selection first");
    expect(() => createPromptAudit(selection, [data.datasets.training[0]], final.executor))
      .toThrow(/overlapping/);
    let auditCalls = 0;
    const finalExecute = final.executor.execute;
    final.executor.execute = async (input: any) => { auditCalls++; return finalExecute(input); };
    const audit = createPromptAudit(selection, final.datasets.test, final.executor);
    const report = await run(storage, "prompts-v1/final-test", audit);
    expect(report.trials.map((t) => t.accepted)).toEqual([false, false]);
    expect(report.trials.map((t) => t.evaluation.test.candidate.accuracy)).toEqual([0.25, 0.875]);
    expect(report.champion).toEqual(audit.plan.initial); // Reporting cannot promote a test winner.
    expect(await run(storage, "prompts-v1/final-test", audit)).toEqual(report);
    expect(auditCalls).toBe(32);
    expect(await run(storage, "prompts-v1", gate)).toEqual(selection);
    expect(calls).toBe(64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("rejects higher accuracy when false cancellations increase", async () => {
  const data = fixture();
  const original = data.executor.execute;
  data.executor.implementation = { ...data.executor.implementation, override: "initial always predicts other" };
  data.executor.execute = async (input: any) => input.prompt === proposals.initial
    ? { output: "other", cost: 0 } : original(input);
  const result = await run(":memory:", "hard-constraint", createPromptGate({
    ...proposals, candidates: [proposals.candidates[1]], datasets: data.datasets,
  }, data.executor));
  const trial = result.trials[0];
  for (const split of Object.values(trial.evaluation)) {
    expect(split.candidate.accuracy).toBeGreaterThan(split.baseline.accuracy);
    expect(split.candidate.falseCancellations).toBeGreaterThan(split.baseline.falseCancellations);
  }
  expect(trial.accepted).toBe(false);
});

it("validates data partitions before execution", () => {
  const data = fixture();
  const bundle = { ...proposals, datasets: data.datasets };
  data.datasets.validation[0] = { ...data.datasets.training[0], id: "different-id" };
  expect(() => createPromptGate(bundle, data.executor)).toThrow(/overlapping/);
  data.datasets.validation[0] = { id: "bad", text: "New case", label: "unknown" };
  expect(() => createPromptGate(bundle, data.executor)).toThrow(/labeled case/);
  delete data.datasets.validation;
  expect(() => createPromptGate(bundle, data.executor)).toThrow(/training and validation only/);
});

it("fails invalid predictions instead of accepting them", async () => {
  const data = fixture();
  data.executor.execute = async () => ({ output: "probably cancel", cost: 0 });
  await expect(run(":memory:", "bad-output", createPromptGate({ ...proposals, datasets: data.datasets }, data.executor)))
    .rejects.toThrow("Executor must return cancel or other");
});

it("reserves a full paired trial before spending", async () => {
  const data = fixture();
  const original = data.executor.execute;
  let calls = 0;
  data.executor = { ...data.executor, costLimit: 1, budget: 31,
    execute: async (input: any) => { calls++; return { ...await original(input), cost: 1 }; } };
  const experiment = createPromptGate({ ...proposals, datasets: data.datasets }, data.executor);
  await expect(run(":memory:", "no-budget", experiment)).rejects.toThrow(/budget exhausted/);
  expect(calls).toBe(0);
});
