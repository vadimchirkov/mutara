// Q4 control runner. See src/q4.ts for what each piece means.
//
//   pnpm run q4 [attempts]

import {
  compareReports,
  contains,
  evaluateDataset,
  exactMatch,
  lengthCheck,
  type EvalReport,
} from "@lambda-house/teob-ts/ai";
import { loadTable, rng } from "./game/table.js";
import { oracle, policies, type Policy } from "./game/policies.js";
import { freshDb, harness } from "./harness.js";
import { viewOf } from "./game/engine.js";
import {
  answer,
  correlation,
  datasetFromGame,
  plausible,
  productive,
  stateOf,
  type Situation,
} from "./q4.js";

const ATTEMPTS = Number(process.argv[2] ?? 120);
const BASELINE_POLICY = "empowerment";

/** A policy answering each recorded situation; the recorded run replays itself. */
const responder =
  (policy?: Policy) =>
  async (_prompt: string, context?: string): Promise<string> => {
    const c = JSON.parse(context ?? "{}") as Situation;
    if (!policy) return ""; // replaced below by the recorded answer
    const s = stateOf(c);
    return answer(policy(viewOf(s), rng((s.seed + s.t * 0x9e3779b9) | 0)));
  };

const table = loadTable();
const evaluators = [
  productive(table),
  plausible(),
  exactMatch(),
  contains(["water"]),
  lengthCheck(20),
];

// One recorded game supplies the states every policy is asked about.
const db = freshDb(new URL("../data/q4.db", import.meta.url).pathname);
const h = harness(db, { table, policies });
await h.play("g0", 1, BASELINE_POLICY, ATTEMPTS);
await h.close();

const dataset = datasetFromGame(db, "g0");
const byId = new Map(dataset.samples.map((s) => [s.context, s.expectedOutput ?? ""]));

const candidates: Array<[string, (p: string, c?: string) => Promise<string>]> = [
  ["recorded", async (_p, c) => byId.get(c ?? "") ?? ""],
  ["random", responder(policies.random)],
  ["oracle", responder(oracle(table))],
];

const reports = new Map<string, EvalReport>();
for (const [name, fn] of candidates) reports.set(name, await evaluateDataset(dataset, fn, evaluators));

const mean = (r: EvalReport, n: string) => r.aggregates.find((a) => a.evaluatorName === n)?.mean ?? 0;
const names = evaluators.map((e) => e.name);
const W = Math.max(...names.map((n) => n.length)) + 2;

console.log(`Q4 control — ${dataset.samples.length} recorded states from one ${BASELINE_POLICY} game\n`);
console.log(["candidate".padEnd(10), ...names.map((n) => n.padStart(W))].join(""));
for (const [name] of candidates) {
  const r = reports.get(name)!;
  console.log([name.padEnd(10), ...names.map((n) => mean(r, n).toFixed(3).padStart(W))].join(""));
}

// The headline: pooled over every sample of every candidate, how closely does
// each evaluator track the truth? A judge is only worth its cost if this is high.
const pooled = new Map<string, number[]>(names.map((n) => [n, []]));
for (const [name] of candidates) {
  for (const r of reports.get(name)!.results) {
    for (const s of r.scores) pooled.get(s.evaluatorName)!.push(s.score);
  }
}
const truthScores = pooled.get("GroundTruth")!;
console.log(`\ncorrelation with the truth, pooled over ${truthScores.length} scored answers:`);
for (const n of names.filter((n) => n !== "GroundTruth")) {
  console.log(`  ${n.padEnd(W)} r = ${correlation(pooled.get(n)!, truthScores).toFixed(3)}`);
}

// The framework's own pairwise comparison, baseline = the recorded run.
const base = reports.get("recorded")!;
console.log(`\ndeltas vs the recorded run (${BASELINE_POLICY}):`);
for (const [name] of candidates.slice(1)) {
  const cmp = compareReports(base, reports.get(name)!);
  const truth = cmp.deltas.find((d) => d.evaluatorName === "GroundTruth")!;
  const agree = cmp.deltas
    .filter((d) => d.evaluatorName !== "GroundTruth")
    .map((d) => `${d.evaluatorName} ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(3)}` +
      `${Math.sign(d.delta) === Math.sign(truth.delta) || d.delta === 0 ? "" : "  <- disagrees with truth"}`);
  console.log(`  ${name}: truth ${truth.delta >= 0 ? "+" : ""}${truth.delta.toFixed(3)}`);
  for (const line of agree) console.log(`      ${line}`);
}
