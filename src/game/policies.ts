// Pair-selection policies.
//
// Every policy is a PURE function of the view (which is derived from the
// journal) plus a seeded RNG, so a run replays identically and a policy can be
// swapped without touching recorded history. None of them may read the recipe
// table — that is the answer sheet — except `oracle`, which is a ceiling and
// labelled as such.

import { pairKey } from "./table.js";
import type { Table } from "./table.js";

export interface Memory {
  /** Pairs an earlier run proved produce nothing at all. Never worth retrying. */
  deadPairs: Set<string>;
  /**
   * Pairs an earlier run proved productive. Still worth retrying: a new game
   * starts from the four base elements and has to re-derive its inventory.
   */
  productive: Set<string>;
  /** Elements that yielded something new in earlier runs. */
  wins: Map<string, number>;
}

/** Outranks any plausible `wins` count, so known-productive pairs go first. */
const PRODUCTIVE_BONUS = 1000;

export interface GameView {
  known: string[];
  tried: Set<string>;
  /** Step at which each element was discovered, for recency. */
  discoveredAt: Map<string, number>;
  /** Elements that yielded something new so far in THIS run. */
  wins: Map<string, number>;
  memory?: Memory;
  t: number;
}

export type Policy = (v: GameView, rand: () => number) => [string, string] | null;

/** Shared driver: score every untried pair, take the argmax, random tiebreak. */
function pick(v: GameView, rand: () => number, score: (a: string, b: string) => number) {
  let best: [string, string] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < v.known.length; i++) {
    for (let j = i; j < v.known.length; j++) {
      const [a, b] = [v.known[i], v.known[j]];
      const key = pairKey(a, b);
      if (v.tried.has(key)) continue;
      // Memory applies to every policy uniformly, so "memory on/off" is one
      // flag rather than a separate policy: skip what past runs proved dead,
      // prefer what they proved productive.
      if (v.memory?.deadPairs.has(key)) continue;
      const bonus = v.memory?.productive.has(key) ? PRODUCTIVE_BONUS : 0;
      const s = score(a, b) + bonus + rand() * 1e-6;
      if (s > bestScore) [bestScore, best] = [s, [a, b]];
    }
  }
  return best;
}

const mem = (v: GameView, e: string) => (v.memory?.wins.get(e) ?? 0);

export const policies: Record<string, Policy> = {
  random: (v, rand) => pick(v, rand, () => 0),

  // A known human bias: keep playing with what you just found.
  recency: (v, rand) =>
    pick(v, rand, (a, b) => (v.discoveredAt.get(a) ?? 0) + (v.discoveredAt.get(b) ?? 0)),

  // Empowerment: prefer elements that have already produced something. This is
  // the effect Brändle et al. found in human players, and it is free.
  empowerment: (v, rand) =>
    pick(v, rand, (a, b) => (v.wins.get(a) ?? 0) + (v.wins.get(b) ?? 0) + mem(v, a) + mem(v, b)),
};

/** Not a baseline: reads the recipe table. Use only as the ceiling. */
export function oracle(table: Table): Policy {
  return (v, rand) => {
    const known = new Set(v.known);
    return pick(v, rand, (a, b) => (table.combine(a, b).some((r) => !known.has(r)) ? 1 : 0));
  };
}
