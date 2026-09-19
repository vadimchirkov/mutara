// Environment adapter. Only this side of the experiment can access recipes.
import { createHash } from "node:crypto";
import { playOffline } from "../game/engine.js";
import type { Table } from "../game/table.js";
import { restoreMemory, weightedPolicy } from "./strategy.js";
import type { Evaluator } from "./experiment.js";

export function alchemyEvaluator(table: Table): Evaluator {
  return async (version, seeds, plan) => {
    if (table.hash !== plan.tableHash) throw new Error("Evaluation world changed");
    const policy = weightedPolicy(version);
    const memory = restoreMemory(plan.memory);
    return seeds.map((seed) => {
      const state = playOffline(table, policy, seed, plan.attempts, memory);
      return { seed, score: state.known.length, attempts: state.t,
        traceHash: `sha256:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}` };
    });
  };
}
