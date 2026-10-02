// Which evaluation changes help `optimize`? Plan and criterion: README.md.
// Run: pnpm build && node examples/eval-bench/bench.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { digest } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { createOptimizer } from "teob-mutara/optimizer";
import { localPropose } from "../search-bench/bench.mjs";

const D = 5, FIELDS = 5, SEEDS = 10, DIR = "runs/eval-bench";
export const base = { rounds: 50, cases: 10, dice: "independent", judge: 0, calls: 1, credit: "partial", rule: "heuristic" };
const CONDITIONS = {
  base: {},
  r100n5: { rounds: 100, cases: 5 },
  r25n20: { rounds: 25, cases: 20 },
  r10n50: { rounds: 10, cases: 50 },
  common: { dice: "common" },
  judge: { judge: 0.2 },
  judge3: { judge: 0.2, calls: 3 },
  judgeN30: { judge: 0.2, cases: 30 },
  allFields: { credit: "all" },
  bounded: { rule: "bounded" },
  boundedR10n50: { rule: "bounded", rounds: 10, cases: 50 },
  sequential: { rule: "sequential" },
  sequentialR10n50: { rule: "sequential", rounds: 10, cases: 50 },
};
const COMPARISONS = [
  ["L1", "base", "r100n5"], ["L1", "base", "r25n20"], ["L1", "base", "r10n50"],
  ["L2", "base", "common"],
  ["L3", "base", "judge"], ["L3", "judge", "judge3"], ["L3", "judge3", "judgeN30"],
  ["L4", "base", "allFields"],
  ["L5", "base", "bounded"], ["L5", "base", "sequential"], ["L5", "r10n50", "boundedR10n50"], ["L5", "r10n50", "sequentialR10n50"],
];

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const hashSeed = (value) => parseInt(digest(value).slice(7, 15), 16);

// Shared with racing.mjs: the task, the optimizer adapter and its plan for one condition.
export function setup(c, gen, seed) {
  const optRand = rng(seed * 7919);
  const optimum = Array.from({ length: D }, () => (optRand() < 0.5 ? -1 : 1) * (1 + 2 * optRand()));
  const keys = Array.from({ length: D }, (_, i) => `x${i}`);
  const space = Object.fromEntries(keys.map((k) => [k, { type: "float", min: -5, max: 5, initial: 0 }]));
  const trueP = (config) => 1 / (1 + keys.reduce((s, k, i) => s + (config[k] - optimum[i]) ** 2, 0) / 10);
  const { adapter, plan } = createOptimizer({
    space, seed,
    metrics: [{ name: "score", direction: "higher", weight: 1, bounds: { min: 0, max: 1 } }],
    decision: { mode: c.rule },
    samplesPerTrial: c.cases,
    budget: { trials: c.rounds, cost: c.rounds * 2 * c.cases * c.calls },
    costLimit: c.calls,
    recovery: "repeatable",
    implementation: { bench: "eval-bench-v1", condition: c, generator: gen, optimum },
    async execute(config, { sample }) {
      const difficulty = 0.5 + 1.5 * rng(hashSeed({ seed, sample, case: true }))(); // shared by both sides
      const dice = rng(hashSeed(c.dice === "common" ? { seed, sample } : { seed, sample, config }));
      const p = trueP(config) ** difficulty;
      const passed = Array.from({ length: FIELDS }, () => dice() < p).filter(Boolean).length;
      const exact = c.credit === "partial" ? passed / FIELDS : Number(passed === FIELDS);
      let score = exact;
      if (c.judge) {
        const judge = rng(hashSeed({ seed, sample, config, judge: true }));
        score = Array.from({ length: c.calls }, () => Math.min(1, Math.max(0, exact + c.judge * gauss(judge))))
          .reduce((a, b) => a + b / c.calls, 0);
      }
      return { output: { score }, cost: c.calls };
    },
  });
  const implId = digest(adapter.implementation);
  const bench = gen === "local"
    ? { ...adapter, propose: (champion, history, p) => localPropose(p.space, implId, champion, history.length, p.seed) }
    : adapter;
  return { adapter: bench, plan, trueP };
}

async function run(name, gen, seed) {
  const id = `eval-bench-v1-${name}-${gen}-${seed}`;
  const { adapter: bench, plan, trueP } = setup({ ...base, ...CONDITIONS[name] }, gen, seed);
  const h = learnerHarness(`${DIR}/${id}.db`, bench);
  try {
    await h.startOrResume(id, plan);
    const state = await h.wait(id);
    let champion = plan.initial.config, bad = 0;
    for (const t of state.trials) if (t.accepted) {
      if (trueP(t.candidate.config) < trueP(champion)) bad++;
      champion = t.candidate.config;
    }
    return { p: trueP(state.champion.config), accepted: state.trials.filter((t) => t.accepted).length, bad, cost: state.spent };
  } finally { await h.close(); }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
const fmt = (xs, digits = 3) => `${mean(xs).toFixed(digits)} ± ${se(xs).toFixed(digits)}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(DIR, { recursive: true });
  const results = {};
  for (const gen of ["random", "local"]) for (const name of Object.keys(CONDITIONS)) {
    const rows = [];
    for (let seed = 1; seed <= SEEDS; seed++) rows.push(await run(name, gen, seed));
    results[`${gen}/${name}`] = rows;
    console.log(`| ${gen} | ${name} | ${fmt(rows.map((r) => r.p))} | ${mean(rows.map((r) => r.accepted)).toFixed(1)} | ` +
      `${mean(rows.map((r) => r.bad)).toFixed(1)} | ${mean(rows.map((r) => r.cost)).toFixed(0)} |`);
  }
  const verdicts = [];
  for (const gen of ["random", "local"]) for (const [lever, a, b] of COMPARISONS) {
    const diff = results[`${gen}/${b}`].map((r, i) => r.p - results[`${gen}/${a}`][i].p);
    const verdict = mean(diff) > 2 * se(diff) ? `${b} better` : mean(diff) < -2 * se(diff) ? `${a} better` : "no difference";
    verdicts.push({ gen, lever, a, b, diffMean: mean(diff), diffSE: se(diff), verdict });
    console.log(`| ${gen} | ${lever} | ${a} → ${b} | ${fmt(diff)} | ${verdict} |`);
  }
  writeFileSync(`${DIR}/results.json`, JSON.stringify({ results, verdicts }, null, 2));
}
