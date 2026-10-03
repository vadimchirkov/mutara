// Experiment 6: where to gate a PSRO run. Reads the per-round exploitability
// journaled by psro-bench.mjs (arm psro) and replays each gate placement; no new
// search, see README.md for why that is exact here.
//   node examples/blotto/psro-gates.mjs [storage] [seeds] [rounds]
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter } from "./psro.mjs";

const storage = process.argv[2] ?? "./runs/blotto/psro.db";
const seeds = Number(process.argv[3] ?? 10);
const rounds = Number(process.argv[4] ?? 100);
const KS = [1, 2, 5, 10, 25, 50];
const learner = learnerHarness(storage, adapter);
const fix = (x) => Number(x.toFixed(4));

// e[r] = exploitability of the ungated champion after round r, e[0] = start.
export function batchGate(e, k) {
  let passed = e[0];
  for (let r = k; r < e.length; r += k) {
    if (e[r] > passed + 1e-9) return { final: passed, frozenAt: r };
    passed = e[r];
  }
  return { final: passed, frozenAt: null };
}
export function bestCheckpoint(e, k) {
  let best = Infinity;
  for (let r = k; r < e.length; r += k) best = Math.min(best, e[r]);
  return best;
}

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean: fix(mean), se: fix(sd / Math.sqrt(xs.length)) };
};

try {
  const rows = [];
  for (let s = 0; s < seeds; s++) {
    const state = await learner.wait(`psro-psro-s${s}`);
    if (state.status !== "finished" || state.trials.length !== rounds || !state.trials.every((t) => t.accepted)) {
      throw new Error(`psro-psro-s${s} is not a finished ungated run of ${rounds} rounds`);
    }
    const e = [state.trials[0].evaluation.champion, ...state.trials.map((t) => t.evaluation.candidate)];
    const row = { seed: s, end: fix(e[rounds]) };
    for (const k of KS) {
      const g = batchGate(e, k);
      row[`batch${k}`] = { final: fix(g.final), frozenAt: g.frozenAt };
      row[`best${k}`] = fix(bestCheckpoint(e, k));
    }
    console.log(JSON.stringify(row));
    rows.push(row);
  }
  const summary = { end: stats(rows.map((r) => r.end)) };
  for (const k of KS) {
    summary[`batch${k}`] = { ...stats(rows.map((r) => r[`batch${k}`].final)), frozen: rows.filter((r) => r[`batch${k}`].frozenAt !== null).length };
    summary[`best${k}`] = stats(rows.map((r) => r[`best${k}`]));
  }
  const diff = stats(rows.map((r) => r.batch25.final - r.end));
  console.log(JSON.stringify({ summary, batch25MinusEnd: diff, criterion: diff.mean > 2 * diff.se ? "costs search" : "safe" }));
} finally {
  await learner.close();
}
