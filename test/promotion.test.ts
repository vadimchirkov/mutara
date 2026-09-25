import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnerHarness } from "../src/sqlite.js";
// @ts-ignore — copied, public-package example intentionally stays runnable JS.
import { adapter, plan } from "../skills/mutara/assets/adapter.mjs";

it("rejects a training winner that regresses on validation and resumes without execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mutara-promotion-"));
  const storage = join(dir, "learning.db");
  let calls = 0;
  const counted = { ...adapter, execute: async (job: any) => {
    calls++;
    expect(job.input).not.toHaveProperty("cases");
    return adapter.execute(job);
  } };
  let learner = learnerHarness(storage, counted);
  try {
    await learner.startOrResume("validation-regression-v1", plan);
    const result = await learner.wait("validation-regression-v1");
    expect(result.trials.map((trial) => trial.accepted)).toEqual([true, true, false]);
    expect(result.trials.at(-1)?.evaluation).toEqual({
      trainingGain: 1 - 5 / 6, validationGain: -0.25,
    });
    expect(result.champion).toEqual(result.trials[1].candidate);
    expect(calls).toBe(12);
    await learner.close();
    learner = learnerHarness(storage, counted);
    await learner.startOrResume("validation-regression-v1", plan);
    expect(await learner.wait("validation-regression-v1")).toEqual(result);
    expect(calls).toBe(12);
  } finally {
    await learner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
