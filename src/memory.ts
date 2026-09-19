// The hypothesis under test, in one file: a past game's record IS the agent's
// memory. Nothing is stored anywhere else — this is a projection, and deleting
// it loses nothing, because it can always be rebuilt from history.
//
// Journals and hand-played sessions are the same thing seen from two angles, so
// both go through one fold. Anything that can name the pairs it tried and what
// they returned is a corpus.

import Database from "better-sqlite3";
import { pairKey } from "./game/table.js";
import type { AlchemyEvent } from "./aggregate.js";

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

/** The only thing a corpus has to provide. */
export interface RecordedAttempt {
  a: string;
  b: string;
  results: string[];
}

export const emptyMemory = (): Memory => ({
  deadPairs: new Set(),
  productive: new Set(),
  wins: new Map(),
});

/**
 * Fold recorded attempts into a prior for the next game.
 *
 * `results` is used rather than `fresh` because freshness is relative to the run
 * that recorded it: a pair can return something that run already knew, which
 * makes it productive, not dead.
 */
export function foldAttempts(attempts: Iterable<RecordedAttempt>): Memory {
  const m = emptyMemory();
  for (const at of attempts) {
    const key = pairKey(at.a, at.b);
    if (at.results.length === 0) {
      m.deadPairs.add(key);
      continue;
    }
    m.productive.add(key);
    for (const el of [at.a, at.b]) m.wins.set(el, (m.wins.get(el) ?? 0) + 1);
  }
  return m;
}

/** Union of two priors. Both are derived, so nothing is lost by rebuilding. */
export function mergeMemory(a: Memory, b?: Memory): Memory {
  if (!b) return a;
  const wins = new Map(a.wins);
  for (const [k, v] of b.wins) wins.set(k, (wins.get(k) ?? 0) + v);
  return {
    deadPairs: new Set([...a.deadPairs, ...b.deadPairs]),
    productive: new Set([...a.productive, ...b.productive]),
    wins,
  };
}

// ------------------------------------------------------------------ journal

export interface JournalRow {
  persistence_id: string;
  sequence_nr: number;
  manifest: string;
  payload: string;
}

export function readJournal(db: string, entity?: string): JournalRow[] {
  const d = new Database(db, { readonly: true });
  const rows = d
    .prepare(
      "SELECT persistence_id, sequence_nr, manifest, payload FROM journal ORDER BY persistence_id, sequence_nr",
    )
    .all() as JournalRow[];
  d.close();
  return entity
    ? rows.filter((r) => r.persistence_id === entity || r.persistence_id.endsWith(`:${entity}`))
    : rows;
}

export function projectMemory(rows: JournalRow[], skipEntity?: string): Memory {
  return foldAttempts(
    rows
      .filter((r) => r.manifest === "pair_tried")
      .filter((r) => !skipEntity || !r.persistence_id.endsWith(`:${skipEntity}`))
      .map((r) => JSON.parse(r.payload) as Extract<AlchemyEvent, { tag: "pair_tried" }>),
  );
}

/** Bytes of journal per entity — the Q3 measurement, taken as we go. */
export function journalBytes(rows: JournalRow[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const r of rows) {
    const n = Buffer.byteLength(r.payload) + Buffer.byteLength(r.manifest);
    per.set(r.persistence_id, (per.get(r.persistence_id) ?? 0) + n);
  }
  return per;
}
