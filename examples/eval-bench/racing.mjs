// Racing: drop a candidate as soon as it looks worse, spend the saved cases on more candidates.
// Plan and results: README.md. Run: pnpm build && node examples/eval-bench/racing.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { learnerHarness } from "teob-mutara/sqlite";
import { base, setup } from "./bench.mjs";

const BUDGET = 1000, MIN_PAIRS = 3, SEEDS = 10, DIR = "runs/racing-bench";
const METHODS = {
  fixed10: { rounds: 50, cases: 10 },
  fixed5: { rounds: 100, cases: 5 },
  race: { rounds: 100, cases: 20, race: "losers" },
  race2: { rounds: 100, cases: 20, race: "both" },
};
const SCORERS = { exact: {}, judge: { judge: 0.2 } };

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
const fmt = (xs) => `${mean(xs).toFixed(3)} ± ${se(xs).toFixed(3)}`;

// Paired gains from the observed prefix; jobs alternate baseline:i, candidate:i.
function gains(runs) {
  const score = (side) => runs.filter((r) => r.job.key.startsWith(side)).map((r) => r.observation.metrics.score);
  const [b, c] = [score("baseline:"), score("candidate:")];
  return b.length === c.length ? c.map((x, i) => x - b[i]) : null;
}

async function run(method, scorer, gen, seed) {
  const c = { ...base, ...SCORERS[scorer], ...METHODS[method] };
  const id = `racing-bench-v1-${method}-${scorer}-${gen}-${seed}`;
  const { adapter, plan, trueP } = setup(c, gen, seed);
  const raced = !c.race ? adapter : {
    ...adapter,
    early(prefix) {
      const d = gains(prefix);
      if (!d || d.length < MIN_PAIRS) return false;
      return mean(d) + se(d) < 0 || (c.race === "both" && mean(d) - 2 * se(d) > 0);
    },
  };
  const h = learnerHarness(`${DIR}/${id}.db`, raced);
  try {
    await h.startOrResume(id, plan);
    const state = await h.wait(id);
    // Equal budget: the champion after the last trial that fits in BUDGET case evaluations.
    let champion = plan.initial.config, spent = 0, trials = 0;
    for (const t of state.trials) {
      const cost = 2 * t.evaluation.candidate.length * c.calls;
      if (spent + cost > BUDGET) break;
      spent += cost; trials++;
      if (t.accepted) champion = t.candidate.config;
    }
    return { p: trueP(champion), trials, spent };
  } finally { await h.close(); }
}

mkdirSync(DIR, { recursive: true });
const results = {};
for (const scorer of Object.keys(SCORERS)) for (const gen of ["random", "local"]) for (const method of Object.keys(METHODS)) {
  const rows = [];
  for (let seed = 1; seed <= SEEDS; seed++) rows.push(await run(method, scorer, gen, seed));
  results[`${scorer}/${gen}/${method}`] = rows;
  console.log(`| ${scorer} | ${gen} | ${method} | ${fmt(rows.map((r) => r.p))} | ${mean(rows.map((r) => r.trials)).toFixed(1)} | ` +
    `${mean(rows.map((r) => r.spent)).toFixed(0)} |`);
}
const verdicts = [];
for (const scorer of Object.keys(SCORERS)) for (const gen of ["random", "local"]) for (const race of ["race", "race2"]) for (const ref of ["fixed10", "fixed5"]) {
  const d = results[`${scorer}/${gen}/${race}`].map((r, i) => r.p - results[`${scorer}/${gen}/${ref}`][i].p);
  const verdict = mean(d) > 2 * se(d) ? `${race} better` : mean(d) < -2 * se(d) ? `${ref} better` : "no difference";
  verdicts.push({ scorer, gen, race, ref, diffMean: mean(d), diffSE: se(d), verdict });
  console.log(`| ${scorer} | ${gen} | ${ref} → ${race} | ${fmt(d)} | ${verdict} |`);
}
writeFileSync(`${DIR}/results.json`, JSON.stringify({ results, verdicts }, null, 2));
