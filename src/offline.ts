// Offline baselines — no runtime, no journal, no API. This is where the bar
// comes from: history-only heuristics top out around 42, humans reach ~51, and
// a table-reading oracle gets ~167. Anything that claims to use world knowledge
// has to beat 42 to be worth its cost.
//
// Protocol follows Brändle et al. 2023 (Nature Hum. Behav. 7:1481): four base
// elements, 158 attempts, count distinct elements discovered.
//
//   pnpm run offline [attempts] [seeds]

import { loadTable } from "./game/table.js";
import { oracle, policies } from "./game/policies.js";
import { playOffline } from "./game/engine.js";

export const HUMAN_MEDIAN = 51;

export interface Baseline {
  policy: string;
  mean: number;
  median: number;
  min: number;
  max: number;
}

export function baselines(attempts: number, seeds: number): Baseline[] {
  const table = loadTable();
  const all = { ...policies, oracle: oracle(table) };
  return Object.entries(all).map(([policy, p]) => {
    const runs = Array.from({ length: seeds }, (_, s) => playOffline(table, p, s + 1, attempts).known.length);
    runs.sort((a, b) => a - b);
    return {
      policy,
      mean: runs.reduce((x, y) => x + y, 0) / runs.length,
      median: runs[runs.length >> 1],
      min: runs[0],
      max: runs[runs.length - 1],
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const attempts = Number(process.argv[2] ?? 158);
  const seeds = Number(process.argv[3] ?? 20);
  const table = loadTable();
  console.log(`table: ${table.elements.length} elements  ${table.hash}`);
  console.log(`protocol: ${attempts} attempts x ${seeds} seeds (human median: ${HUMAN_MEDIAN})\n`);
  for (const b of baselines(attempts, seeds)) {
    console.log(
      `${b.policy.padEnd(12)} mean ${b.mean.toFixed(1).padStart(6)}  median ${String(b.median).padStart(3)}` +
        `  min ${b.min}  max ${b.max}${b.policy === "oracle" ? "   <- ceiling, reads the table" : ""}`,
    );
  }
}
