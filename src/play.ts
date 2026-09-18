// Play by hand, or watch a policy play.
//
// The point of playing it yourself is a human baseline measured under exactly
// this protocol, on exactly this table — the 51 quoted from Brändle et al. is
// orientation, not a controlled comparison.
//
//   pnpm run play                    you play, 158 attempts
//   pnpm run play 60                 you play, 60 attempts
//   pnpm run play empowerment 7      watch a policy, seed 7
//
// Uses the offline engine, not the runtime: this is for looking at the game,
// not for producing journals. Use `pnpm run bench` for those.

import { createInterface } from "node:readline/promises";
import { loadTable, pairKey } from "./game/table.js";
import { oracle, policies } from "./game/policies.js";
import { applyStep, initialGame, startGame, step, type GameState } from "./game/engine.js";
import { HUMAN_MEDIAN } from "./offline.js";

const table = loadTable();
const [a1, a2] = process.argv.slice(2);
const policyName = a1 && Number.isNaN(Number(a1)) ? a1 : undefined;
const attempts = Number(policyName ? 158 : (a1 ?? 158));

function report(s: GameState, label: string) {
  console.log(`\n${label}: ${s.known.length} elements in ${s.t} attempts (human median ${HUMAN_MEDIAN})`);
  console.log(s.known.join(", "));
}

if (policyName) {
  const policy = policyName === "oracle" ? oracle(table) : policies[policyName];
  if (!policy) {
    console.error(`unknown policy ${policyName}; try: ${[...Object.keys(policies), "oracle"].join(", ")}`);
    process.exit(1);
  }
  let s = startGame(initialGame(), Number(a2 ?? 1), policyName, attempts, table.hash);
  for (let t = 0; t < attempts; t++) {
    const st = step(s, table, policy);
    if (!st) break;
    if (st.fresh.length) console.log(`${String(t).padStart(4)}  ${st.a} + ${st.b}  ->  ${st.fresh.join(", ")}`);
    s = applyStep(s, { ...st, t });
  }
  report(s, policyName);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let s = startGame(initialGame(), 0, "human", attempts, table.hash);

  console.log(`Little Alchemy 2 — ${table.elements.length} elements reachable, ${attempts} attempts.`);
  console.log(`Combine two of what you have: "water + fire", or "water fire".`);
  console.log(`Commands: ? to list what you have, q to stop.\n`);

  // `rl.question` never settles once the stream closes, so Ctrl-D and a closed
  // pipe have to be raced explicitly or the process hangs on an unsettled await.
  const closed = new Promise<undefined>((res) => rl.once("close", () => res(undefined)));

  while (s.t < attempts) {
    const answer = await Promise.race([
      rl.question(`[${s.t + 1}/${attempts}] ${s.known.length} elements > `),
      closed,
    ]);
    if (answer === undefined) break;
    const line = answer.trim();
    if (line === "q") break;
    if (line === "?" || line === "") {
      console.log(s.known.join(", "));
      continue;
    }
    const parts = line.split(/\s*\+\s*|\s+/).filter(Boolean);
    if (parts.length !== 2) {
      console.log("  need exactly two elements");
      continue;
    }
    const [a, b] = parts;
    const missing = [a, b].find((e) => !s.known.includes(e));
    if (missing) {
      console.log(`  you do not have "${missing}"`);
      continue;
    }
    if (s.tried.includes(pairKey(a, b))) {
      console.log("  already tried that pair (it does not cost an attempt)");
      continue;
    }
    const results = table.combine(a, b);
    const known = new Set(s.known);
    const fresh = results.filter((r) => !known.has(r));
    s = applyStep(s, { a, b, results, fresh, t: s.t });
    console.log(
      fresh.length
        ? `  -> ${fresh.join(", ")}`
        : results.length
          ? `  -> ${results.join(", ")} (already had it)`
          : "  -> nothing",
    );
  }
  rl.close();
  report(s, "you");
}
