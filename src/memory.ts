// The hypothesis under test, in one file: the journal of past games IS the
// agent's memory. Nothing is stored anywhere else — this is a projection, and
// deleting it loses nothing, because it can always be rebuilt from history.

import Database from "better-sqlite3";
import { pairKey } from "./game/table.js";
import type { Memory } from "./game/policies.js";
import type { AlchemyEvent } from "./aggregate.js";

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

export const emptyMemory = (): Memory => ({
  deadPairs: new Set(),
  productive: new Set(),
  wins: new Map(),
});

/**
 * Fold every recorded attempt into a prior for the next game.
 *
 * `results` is used rather than `fresh` because freshness is relative to the run
 * that recorded it: a pair can return something that run already knew, which
 * makes it productive, not dead.
 */
export function projectMemory(rows: JournalRow[], skipEntity?: string): Memory {
  const m = emptyMemory();
  for (const row of rows) {
    if (row.manifest !== "pair_tried") continue;
    if (skipEntity && row.persistence_id.endsWith(`:${skipEntity}`)) continue;
    const e = JSON.parse(row.payload) as Extract<AlchemyEvent, { tag: "pair_tried" }>;
    const key = pairKey(e.a, e.b);
    if (e.results.length === 0) {
      m.deadPairs.add(key);
      continue;
    }
    m.productive.add(key);
    for (const el of [e.a, e.b]) m.wins.set(el, (m.wins.get(el) ?? 0) + 1);
  }
  return m;
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
