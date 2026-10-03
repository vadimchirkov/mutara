// Experiment 5: psro vs psro-gated on Colonel Blotto, $0. Criteria are fixed in README.md.
//   node examples/blotto/psro-bench.mjs [storage] [seeds] [rounds]
import { learnerHarness } from "teob-mutara/sqlite";
import { pureStrategies, rng } from "./blotto.mjs";
import { adapter, psroVersion } from "./psro.mjs";

const storage = process.argv[2] ?? "./runs/blotto/psro.db";
const seeds = Number(process.argv[3] ?? 10);
const rounds = Number(process.argv[4] ?? 100);
const learner = learnerHarness(storage, adapter);
const fix = (x) => Number(x.toFixed(4));
const CHECKPOINTS = [10, 25, 50, 100].filter((r) => r <= rounds);
// Start of seed s: a population of one distribution drawn by seed.
const start = (s) => {
  const all = pureStrategies();
  return psroVersion([all[Math.floor(rng(9000 + s)() * all.length)]], [1]);
};

async function arm(rule, s) {
  const id = `psro-${rule}-s${s}`;
  const t0 = performance.now();
  await learner.startOrResume(id, { rule, rounds, seed: s, initial: start(s) });
  const state = await learner.wait(id);
  const ms = (performance.now() - t0) / rounds;
  // Champion exploitability after round r.
  const after = (r) => {
    const t = state.trials[r - 1];
    return fix(t.accepted ? t.evaluation.candidate : t.evaluation.champion);
  };
  const last = state.trials.at(-1);
  return {
    curve: Object.fromEntries(CHECKPOINTS.map((r) => [r, after(r)])),
    exploitability: after(rounds),
    support: state.champion.weights.filter((w) => w > 0.01).length,
    population: state.champion.population.length,
    accepted: state.trials.filter((t) => t.accepted).length,
    msPerRound: Math.round(ms),
    lastReason: last.reason,
  };
}

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean: fix(mean), se: fix(sd / Math.sqrt(xs.length)) };
};

try {
  const rows = [];
  for (let s = 0; s < seeds; s++) {
    const row = { seed: s, psro: await arm("psro", s), gated: await arm("gated", s) };
    console.log(JSON.stringify(row));
    rows.push(row);
  }
  const summary = {};
  for (const a of ["psro", "gated"]) {
    summary[a] = {
      curve: Object.fromEntries(CHECKPOINTS.map((r) => [r, stats(rows.map((x) => x[a].curve[r]))])),
      support: stats(rows.map((x) => x[a].support)),
      accepted: stats(rows.map((x) => x[a].accepted)),
    };
  }
  const final = stats(rows.map((x) => x.psro.exploitability));
  const gatedMinusPsro = stats(rows.map((x) => x.gated.exploitability - x.psro.exploitability));
  const pass = final.mean < 0.25 && 0.5 - final.mean > 2 * final.se;
  console.log(JSON.stringify({ summary, final, gatedMinusPsro, criterion: pass ? "pass" : "fail" }));
} finally {
  await learner.close();
}
