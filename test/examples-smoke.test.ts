// Smoke for the game starters (examples/tictactoe, examples/connect4).
// One round on 4+4 seeds each: catches core Adapter/harness drift, not strength.
// Full measurements live in the examples' own bench scripts + READMEs.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnerHarness } from "../src/sqlite.js";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as ttt from "../examples/tictactoe/experiment.mjs";
// @ts-ignore — examples are untyped .mjs starters, imported deliberately.
import * as c4 from "../examples/connect4/experiment.mjs";

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
});
