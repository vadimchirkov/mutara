// Hand-played sessions.
//
// A human session records the same attempt sequence an agent produces, which is
// the point: it makes a person a comparable player rather than a figure quoted
// from a paper, and it makes human play a corpus the agent can learn from —
// the same projection, over a different journal.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BASE } from "./game/table.js";
import { foldAttempts, type Memory } from "./memory.js";

export interface SessionAttempt {
  at: string;
  a: string;
  b: string;
  results: string[];
  fresh: string[];
  /** Humans re-try pairs; agents do not. It still costs an attempt. */
  repeat: boolean;
}

export interface Session {
  startedAt?: string;
  budget: number;
  /** Whether already-tried pairs were hidden from the picker. */
  assist: boolean;
  attempts: SessionAttempt[];
}

const DIR = new URL("../data/sessions/", import.meta.url);

export function saveSession(s: Session): string {
  mkdirSync(DIR, { recursive: true });
  const file = new URL(`${new Date().toISOString().replace(/[:.]/g, "-")}.json`, DIR);
  writeFileSync(file, JSON.stringify(s, null, 2));
  return file.pathname;
}

export function loadSessions(): Session[] {
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as Session);
}

export interface SessionStats {
  sessions: number;
  attempts: number;
  discovered: number;
  hitRate: number;
}

export function sessionStats(s: Session): SessionStats {
  const known = new Set<string>(BASE);
  for (const a of s.attempts) for (const r of a.results) known.add(r);
  const hits = s.attempts.filter((a) => a.fresh.length > 0).length;
  return {
    sessions: 1,
    attempts: s.attempts.length,
    discovered: known.size,
    hitRate: s.attempts.length ? hits / s.attempts.length : 0,
  };
}

/** Same fold as the journal's, over hand-played attempts instead of events. */
export function memoryFromSessions(sessions: Session[]): Memory {
  return foldAttempts(sessions.flatMap((s) => s.attempts));
}
