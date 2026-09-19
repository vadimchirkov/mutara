// Playable terminal alchemy — the human half of the bench.
//
// A hand-played session records the same attempt sequence an agent produces, so
// human runs become the baseline corpus instead of a figure quoted from a paper.
// Sessions are written to data/sessions/ and can be projected into a prior with
// `memoryFromSessions`, exactly as the journal is.
//
//   pnpm run play                       play, 158 attempts
//   pnpm run play --budget 60 --assist  shorter, and hide pairs already tried
//   pnpm run play --policy empowerment --seed 7    watch a policy instead
//
// `--assist` is off by default: agents track what they have tried, humans in the
// reference study did not, and turning it on quietly makes the two incomparable.
//
// This uses the offline engine and writes no journal — see `pnpm run bench`.

import * as p from "@clack/prompts";
import { BASE, loadTable } from "./game/table.js";
import { oracle, policies } from "./game/policies.js";
import { applyStep, initialGame, startGame, step } from "./game/engine.js";
import { saveSession, type SessionAttempt } from "./sessions.js";
import { chip, row } from "./ui/sprites.js";
import { HUMAN_MEDIAN } from "./offline.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const budget = Number(value("budget")) || 158;
const assist = flag("assist");
const table = loadTable();
const pairKey = (a: string, b: string) => [a, b].sort().join(" + ");

// --------------------------------------------------------------- policy mode

const policyName = value("policy");
if (policyName) {
  const policy = policyName === "oracle" ? oracle(table) : policies[policyName];
  if (!policy) {
    console.error(`unknown policy ${policyName}; try: ${[...Object.keys(policies), "oracle"].join(", ")}`);
    process.exit(1);
  }
  let s = startGame(initialGame(), {
    seed: Number(value("seed") ?? 1),
    policy: policyName,
    attempts: budget,
    tableHash: table.hash,
  });
  for (let t = 0; t < budget; t++) {
    const st = step(s, table, policy);
    if (!st) break;
    if (st.fresh.length) {
      console.log(`${String(t).padStart(4)}  ${st.a} + ${st.b}  ->  ${st.fresh.join(", ")}`);
    }
    s = applyStep(s, { ...st, t });
  }
  console.log(`\n${policyName}: ${s.known.length} elements in ${s.t} attempts (human median ${HUMAN_MEDIAN})`);
  process.exit(0);
}

// ---------------------------------------------------------------- human mode

const known = new Set<string>(BASE);
const tried = new Set<string>();
const attempts: SessionAttempt[] = [];
const discoveredAt = new Map<string, number>(BASE.map((e) => [e, -1]));

/** Inventory, newest discovery first — fresh elements are what you reach for. */
const inventory = () =>
  [...known]
    .sort((a, b) => (discoveredAt.get(b) ?? 0) - (discoveredAt.get(a) ?? 0))
    .map((e) => ({ value: e, label: `${chip(e)} ${e}` }));

// `first` is the already-picked element, if any. Combining an element with
// itself is legal and necessary: 141 recipes are self-pairs (fire + fire ->
// energy), so the second pick must not exclude the first.
async function pick(message: string, first?: string, initialValue?: string) {
  let options = inventory();
  if (assist && first) {
    const usable = options.filter((o) => !tried.has(pairKey(first, o.value)));
    if (usable.length) options = usable;
  }
  const choice = await p.autocomplete({
    message,
    options,
    initialValue,
    maxItems: 10,
    placeholder: "type to search — esc to finish",
  });
  return p.isCancel(choice) ? null : (choice as string);
}

p.intro("alchemy — combine two elements, discover a third");
p.note(
  `${budget} attempts. Start: ${BASE.join(", ")}.\nThe reference human median is ${HUMAN_MEDIAN} elements.`,
  "how to play",
);

// Chain from the last discovery: after finding something, that is almost always
// what you want to combine next, and hunting for it in the list again is friction.
let lead: string | undefined;

while (attempts.length < budget) {
  const left = budget - attempts.length;
  const a = await pick(`${known.size} found · ${left} left`, undefined, lead);
  if (!a) break;
  const b = await pick(`${a}  +  ?`, a);
  if (!b) break;

  const key = pairKey(a, b);
  const repeat = tried.has(key);
  const results = table.combine(a, b);
  const fresh = results.filter((r) => !known.has(r));

  tried.add(key);
  attempts.push({ at: new Date().toISOString(), a, b, results, fresh, repeat });
  for (const r of fresh) {
    known.add(r);
    discoveredAt.set(r, attempts.length);
  }

  // Sprites are the reward, so only a discovery earns them. Most attempts fail;
  // drawing four rows of art for each one buries the finds in the scrollback.
  const note = repeat ? "   (already tried that pair)" : "";
  if (fresh.length) {
    lead = fresh[0];
    // Caption order follows the pick order, not the sorted pair key — otherwise
    // the words contradict the picture.
    const extra = fresh.length > 1 ? `  (+ ${fresh.slice(1).join(", ")})` : "";
    p.log.success(`${row([a, b, fresh[0]], ["+", "→"]).join("\n")}${extra}${note}`);
  } else if (results.length) {
    p.log.info(`${key}  →  ${results.join(", ")}   already known${note}`);
  } else {
    p.log.warn(`${key}  →  nothing${note}`);
  }
}

const hits = attempts.filter((x) => x.fresh.length).length;
p.note(
  `discovered ${known.size} elements (${known.size - BASE.length} beyond the starting four)\n` +
    `used ${attempts.length} of ${budget} attempts\n` +
    `hit rate ${((hits / (attempts.length || 1)) * 100).toFixed(0)}%\n` +
    `human median at 158 attempts: ${HUMAN_MEDIAN}`,
  "result",
);
p.outro(`session saved: ${saveSession({ startedAt: attempts[0]?.at, budget, assist, attempts })}`);
