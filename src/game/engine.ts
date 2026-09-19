// Game state and the single pure step, shared by the offline probe and the TEOB
// aggregate. Both must produce identical runs from the same seed — that identity
// is what makes the journal a faithful record rather than a log.
//
// State is deliberately JSON-safe (arrays and plain objects, no Map/Set). That
// is the F9/F10 lesson from AGENT-JOURNAL-HYPOTHESIS.md: a Map in aggregate
// state is silently destroyed by `JSON.stringify` at the first snapshot.

import { BASE, pairKey, rng, type Table } from "./table.js";
import type { GameView, Policy } from "./policies.js";
import type { Memory } from "../memory.js";

export interface GameState {
  seed: number;
  policy: string;
  attempts: number;
  tableHash: string;
  /** Provenance of the decision inputs; see src/provenance.ts. */
  policyHash: string;
  memoryHash: string;
  t: number;
  known: string[];
  tried: string[];
  discoveredAt: Record<string, number>;
  wins: Record<string, number>;
  status: "idle" | "playing" | "finished";
}

export const initialGame = (): GameState => ({
  seed: 0,
  policy: "random",
  attempts: 0,
  tableHash: "",
  policyHash: "",
  memoryHash: "none",
  t: 0,
  known: [],
  tried: [],
  discoveredAt: {},
  wins: {},
  status: "idle",
});

export function viewOf(s: GameState, memory?: Memory): GameView {
  return {
    known: s.known,
    tried: new Set(s.tried),
    discoveredAt: new Map(Object.entries(s.discoveredAt)),
    wins: new Map(Object.entries(s.wins)),
    memory,
    t: s.t,
  };
}

export interface Step {
  a: string;
  b: string;
  results: string[];
  /** Results not already known — the only part that changes the score. */
  fresh: string[];
}

/**
 * One attempt. Pure: same state + seed + policy + table => same step.
 * Returns null when the policy has no untried pair left to offer.
 */
export function step(
  s: GameState,
  table: Table,
  policy: Policy,
  memory?: Memory,
): Step | null {
  // Per-step RNG derived from (seed, t), so a step never depends on how the
  // previous ones were driven — only on where the run is.
  const rand = rng((s.seed + s.t * 0x9e3779b9) | 0);
  const pair = policy(viewOf(s, memory), rand);
  if (!pair) return null;
  const [a, b] = pair;
  const results = table.combine(a, b);
  const known = new Set(s.known);
  return { a, b, results, fresh: results.filter((r) => !known.has(r)) };
}

/** Fold a step into state. The aggregate's `apply` is exactly this. */
export function applyStep(s: GameState, st: Step & { t: number }): GameState {
  const discoveredAt = { ...s.discoveredAt };
  const wins = { ...s.wins };
  for (const r of st.fresh) discoveredAt[r] = st.t;
  if (st.fresh.length) for (const e of [st.a, st.b]) wins[e] = (wins[e] ?? 0) + 1;
  return {
    ...s,
    t: st.t + 1,
    known: [...s.known, ...st.fresh],
    tried: [...s.tried, pairKey(st.a, st.b)],
    discoveredAt,
    wins,
  };
}

export interface GameStart {
  seed: number;
  policy: string;
  attempts: number;
  tableHash: string;
  policyHash?: string;
  memoryHash?: string;
}

export function startGame(_s: GameState, start: GameStart): GameState {
  return {
    ...initialGame(),
    ...start,
    policyHash: start.policyHash ?? "",
    memoryHash: start.memoryHash ?? "none",
    known: [...BASE],
    status: "playing",
  };
}

/** Play a whole game in process, with no runtime. The offline reference. */
export function playOffline(
  table: Table,
  policy: Policy,
  seed: number,
  attempts: number,
  memory?: Memory,
): GameState {
  let s = startGame(initialGame(), { seed, policy: "offline", attempts, tableHash: table.hash });
  for (let t = 0; t < attempts; t++) {
    const st = step(s, table, policy, memory);
    if (!st) break;
    s = applyStep(s, { ...st, t });
  }
  return { ...s, status: "finished" };
}
