// Q4, with a control: do reference-free evaluators agree with the truth?
//
// AGENT-JOURNAL-HYPOTHESIS.md settles Q4 in shape — "better" is not a scalar,
// and reference-based scoring marks any change a regression — but leaves it open
// in substance: which evaluators should a user reach for? teob-ts cannot answer
// that, because a support reply has no correct answer to check against.
//
// This bench can. The recipe table says exactly which pairs are productive, so
// every candidate gets a true score alongside the usual ones, and an evaluator
// can be caught disagreeing with reality.
//
// The comparison is per-state, not per-run. A candidate that picks differently
// diverges immediately and its later states are its own, so scoring whole
// trajectories would compare two different games. Instead every recorded state
// is replayed and each policy answers the same question: what would you pick
// here? That is Stage 6's "replay logic against recorded inputs", where the
// recorded input is the game state.
//
// The pure pieces live here; `src/q4-control.ts` is the runner.

import type { EvalDataset, EvalInput, Evaluator } from "@lambda-house/teob-ts/ai";
import { pairKey, type Table } from "./game/table.js";
import { readJournal } from "./memory.js";
import { applyStep, initialGame, startGame, type GameState } from "./game/engine.js";
import type { AlchemyEvent } from "./aggregate.js";

export type { GameState };

/** What a policy needs to answer, carried through `EvalSample.context`. */
export type Situation = Pick<GameState, "seed" | "t" | "known" | "tried" | "discoveredAt" | "wins">;

export const situationOf = (s: GameState): Situation => ({
  seed: s.seed,
  t: s.t,
  known: s.known,
  tried: s.tried,
  discoveredAt: s.discoveredAt,
  wins: s.wins,
});

/** Rebuild enough state for a policy to make its choice. */
export const stateOf = (c: Situation): GameState => ({ ...initialGame(), ...c, status: "playing" });

export const answer = (pair: [string, string] | null) => (pair ? pairKey(pair[0], pair[1]) : "");

/**
 * Every recorded attempt becomes one sample: the state as it stood, and the
 * pair the recorded run chose there as `expectedOutput` — the previous answer,
 * not a correct one.
 */
export function datasetFromGame(db: string, entity: string): EvalDataset {
  let state = initialGame();
  const samples = [];
  for (const row of readJournal(db, entity)) {
    const e = JSON.parse(row.payload) as AlchemyEvent;
    if (e.tag === "game_started") {
      state = startGame(state, e);
    } else if (e.tag === "pair_tried") {
      samples.push({
        id: `${entity}:${e.t}`,
        prompt: `${state.known.length} elements known, ${state.tried.length} pairs tried. Which pair next?`,
        expectedOutput: pairKey(e.a, e.b),
        context: JSON.stringify(situationOf(state)),
      });
      state = applyStep(state, e);
    }
  }
  return { name: `alchemy:${entity}`, version: "1", samples };
}

/** The control: was the proposed pair actually productive in that state? */
export function productive(table: Table): Evaluator {
  return {
    name: "GroundTruth",
    async evaluate(input: EvalInput) {
      const c = JSON.parse(input.context ?? "{}") as Situation;
      const parts = input.response.split(" + ");
      const [a, b] = parts;
      const known = new Set(c.known);
      if (parts.length !== 2 || !known.has(a) || !known.has(b) || c.tried.includes(pairKey(a, b))) {
        return { evaluatorName: "GroundTruth", score: 0 };
      }
      const fresh = a && b ? table.combine(a, b).filter((r) => !known.has(r)) : [];
      return { evaluatorName: "GroundTruth", score: fresh.length > 0 ? 1 : 0 };
    },
  };
}

/**
 * A reference-free evaluator that actually encodes a notion of quality: both
 * elements have produced something before. It never reads the recipe table, so
 * it is the shape a real judge would take — a rubric applied to the answer,
 * with no access to the truth. Included to show that "reference-free" is not
 * the property that matters; encoding the task is.
 */
export function plausible(): Evaluator {
  return {
    name: "PriorPlausible",
    async evaluate(input: EvalInput) {
      const c = JSON.parse(input.context ?? "{}") as Situation;
      const [a, b] = input.response.split(" + ");
      const wins = (e?: string) => (e && c.wins[e] ? 1 : 0);
      return { evaluatorName: "PriorPlausible", score: (wins(a) + wins(b)) / 2 };
    },
  };
}

/** Pearson correlation; the question is which evaluator tracks the truth. */
export function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}
