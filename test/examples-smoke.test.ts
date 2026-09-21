// Smoke for the game starters (tictactoe, connect4, pig, kuhn).
// One round on tiny plans: catches core Adapter/harness drift, not strength.
// Full measurements live in the examples' own bench scripts + READMEs.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnerHarness } from "../src/sqlite.js";
import { optimize } from "../src/optimizer.js";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as ttt from "../examples/tictactoe/experiment.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as tuning from "../examples/tictactoe/tuning.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as pig from "../examples/pig/experiment.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as c4 from "../examples/connect4/experiment.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as kuhn from "../examples/kuhn/experiment.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as kuhnCfr from "../examples/kuhn/cfr.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as auto from "../examples/tictactoe/auto.mjs";

function withDatabase(run: (storage: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "mutara-examples-smoke-"));
  return run(join(dir, "learning.db")).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("game starter smoke", () => {
  it("tictactoe adapter runs one round to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, ttt.adapter);
      try {
        const plan = ttt.buildPlan({
          rounds: 1,
          trainingSeeds: [101, 102, 103, 104],
          validationSeeds: [1001, 1002, 1003, 1004],
        });
        await h.start("ttt-smoke", plan);
        const state = await h.wait("ttt-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(1);
        expect(state.executions).toBe(4);
        expect(state.champion?.id).toBeTypeOf("string");
      } finally {
        await h.close();
      }
    });
  });

  it("connect4 adapter runs one round to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, c4.adapter);
      try {
        const plan = c4.buildPlan({
          rounds: 1,
          trainingSeeds: [101, 102, 103, 104],
          validationSeeds: [1001, 1002, 1003, 1004],
        });
        await h.start("c4-smoke", plan);
        const state = await h.wait("c4-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(1);
        expect(state.executions).toBe(4);
        expect(state.champion?.id).toBeTypeOf("string");
      } finally {
        await h.close();
      }
    });
  });

  it("tictactoe optimizer path runs a tiny search", async () => {
    await withDatabase(async (storage) => {
      const result = await optimize({
        id: "ttt-tune-smoke",
        storage,
        space: tuning.space,
        metrics: [{ name: "score", direction: "higher", weight: 1 }],
        implementation: { execute: tuning.execute.toString(), ...tuning.implementation },
        execute: tuning.execute,
        recovery: "repeatable",
        decision: { mode: "heuristic" },
        budget: { trials: 1 },
        samplesPerTrial: 1, // 1 trial * 1 case * 2 (baseline+candidate) = 2 games
      });
      expect(result.totalTrials).toBe(1);
      expect(result.executions).toBe(2);
      expect(result.champion.uctC).toBeTypeOf("number");
    });
  });

  it("pig adapter runs one round to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, pig.adapter);
      try {
        const plan = pig.buildPlan({
          rounds: 1,
          trainingSeeds: [101, 102, 103, 104],
          validationSeeds: [1001, 1002, 1003, 1004],
        });
        await h.start("pig-smoke", plan);
        const state = await h.wait("pig-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(1);
        expect(state.executions).toBe(4);
        expect(state.champion?.id).toBeTypeOf("string");
      } finally {
        await h.close();
      }
    });
  });

  it("kuhn adapter runs one round to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, kuhn.adapter);
      try {
        const plan = kuhn.buildPlan({ rounds: 1 });
        await h.start("kuhn-smoke", plan);
        const state = await h.wait("kuhn-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(1);
        expect(state.executions).toBe(4);
        expect(state.champion?.id).toBeTypeOf("string");
      } finally {
        await h.close();
      }
    });
  });

  it("kuhn CFR adapter runs two iterations to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, kuhnCfr.adapter);
      try {
        const plan = kuhnCfr.buildCfrPlan({ rounds: 2 });
        await h.start("kuhn-cfr-smoke", plan);
        const state = await h.wait("kuhn-cfr-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(2);
        expect(state.executions).toBe(2);
        expect((state.champion as unknown as { iter: number })?.iter).toBe(2);
      } finally {
        await h.close();
      }
    });
  });

  it("machine-dictionary adapter runs one round to finish", async () => {
    await withDatabase(async (storage) => {
      const h = learnerHarness(storage, auto.adapter);
      try {
        const plan = auto.buildAutoPlan({
          rounds: 1,
          trainingSeeds: [101, 102, 103, 104],
          validationSeeds: [1001, 1002, 1003, 1004],
        });
        await h.start("ttt-auto-smoke", plan);
        const state = await h.wait("ttt-auto-smoke");
        expect(state.status).toBe("finished");
        expect(state.trials).toHaveLength(1);
        expect(state.executions).toBe(4);
        expect(state.champion?.id).toBeTypeOf("string");
      } finally {
        await h.close();
      }
    });
  });
});
