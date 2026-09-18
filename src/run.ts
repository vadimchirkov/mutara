// The bench: does an agent whose only memory is its own journal get better?
//
// Two arms, identical in every other way:
//   memory off — each game starts blind
//   memory on  — before each game, the journal of all earlier games is
//                projected into a prior (src/memory.ts)
//
// Ground truth is the recipe table, so no judge is needed to score this. The
// output is results-alchemy.json.
//
//   pnpm run bench [games] [attempts]

import { writeFileSync } from "node:fs";
import { loadTable } from "./game/table.js";
import { policies } from "./game/policies.js";
import { freshDb, harness } from "./harness.js";
import { emptyMemory, journalBytes, projectMemory, readJournal } from "./memory.js";
import { baselines, HUMAN_MEDIAN } from "./offline.js";
import type { AlchemyDeps } from "./aggregate.js";

const GAMES = Number(process.argv[2] ?? 10);
const ATTEMPTS = Number(process.argv[3] ?? 158);
const POLICY = "empowerment";

interface Arm {
  memory: boolean;
  discoveries: number[];
  bytesPerGame: number;
  events: number;
}

async function arm(memory: boolean): Promise<Arm> {
  const table = loadTable();
  const path = freshDb(new URL(`../data/bench-${memory ? "mem" : "blind"}.db`, import.meta.url).pathname);
  // `deps.memory` is read on every decide, so replacing it between games is how
  // the prior grows. Nothing else differs between the two arms.
  const deps: AlchemyDeps = { table, policies, memory: emptyMemory() };
  const h = harness(path, deps);
  const discoveries: number[] = [];

  for (let g = 0; g < GAMES; g++) {
    deps.memory = memory ? projectMemory(readJournal(path)) : emptyMemory();
    const state = await h.play(`g${g}`, g + 1, POLICY, ATTEMPTS);
    discoveries.push(state?.known.length ?? 0);
  }
  await h.close();

  const rows = readJournal(path);
  const bytes = [...journalBytes(rows).values()];
  return {
    memory,
    discoveries,
    bytesPerGame: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length),
    events: Math.round(rows.length / GAMES),
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const blind = await arm(false);
const remembering = await arm(true);
const base = baselines(ATTEMPTS, 20);

const results = {
  generatedAt: new Date().toISOString(),
  protocol: { games: GAMES, attempts: ATTEMPTS, policy: POLICY, humanMedian: HUMAN_MEDIAN },
  table: { hash: loadTable().hash, elements: loadTable().elements.length },
  offlineBaselines: base,
  arms: {
    blind: { ...blind, mean: mean(blind.discoveries) },
    memory: { ...remembering, mean: mean(remembering.discoveries) },
  },
  // The headline: what the journal-as-memory is worth, in elements per game.
  lift: mean(remembering.discoveries) - mean(blind.discoveries),
};

writeFileSync(new URL("../results-alchemy.json", import.meta.url), JSON.stringify(results, null, 2));

console.log(`table ${results.table.elements} elements, ${GAMES} games x ${ATTEMPTS} attempts, policy ${POLICY}\n`);
for (const b of base) console.log(`  baseline ${b.policy.padEnd(12)} ${b.mean.toFixed(1)}`);
console.log(`  human median ${HUMAN_MEDIAN}\n`);
console.log(`blind   ${blind.discoveries.join(" ")}   mean ${mean(blind.discoveries).toFixed(1)}`);
console.log(`memory  ${remembering.discoveries.join(" ")}   mean ${mean(remembering.discoveries).toFixed(1)}`);
console.log(`\nlift ${results.lift.toFixed(1)} elements/game`);
console.log(`journal ${remembering.events} events, ${remembering.bytesPerGame} B per game`);
console.log(`\nwrote results-alchemy.json`);
