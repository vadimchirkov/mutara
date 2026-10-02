// Local mutation (B) vs the built-in random search (A) on noisy synthetic functions.
// Protocol and criterion: README.md. Run: pnpm build && node examples/search-bench/bench.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { digest, version } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { createOptimizer } from "teob-mutara/optimizer";

const ROUNDS = 50, CASES = 10, SEEDS = 10, DIR = "runs/search-bench";
const FUNCTIONS = {
  quadratic: (z) => z.reduce((s, v) => s + v * v, 0),
  rosenbrock: (z) => z.slice(0, -1).reduce((s, v, i) => s + 100 * (z[i + 1] - v * v) ** 2 + (1 - v) ** 2, 0),
  rastrigin: (z) => 10 * z.length + z.reduce((s, v) => s + v * v - 10 * Math.cos(2 * Math.PI * v), 0),
};

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

// Candidate for src/search.ts if the criterion passes: mutate 1-2 dimensions of the champion.
export function localPropose(space, implementationId, champion, round, seed) {
  const rand = rng(seed + round * 0x9e3779b9 + 1);
  const keys = Object.keys(space).sort();
  const picked = new Set();
  const count = Math.min(keys.length, rand() < 0.5 ? 1 : 2);
  while (picked.size < count) picked.add(keys[Math.floor(rand() * keys.length)]);
  const config = { ...champion.config };
  for (const key of [...picked].sort()) {
    const dim = space[key], v = config[key];
    if (dim.type === "float") config[key] = Math.min(dim.max, Math.max(dim.min, v + 0.1 * (dim.max - dim.min) * gauss(rand)));
    else if (dim.type === "int") config[key] = Math.min(dim.max, Math.max(dim.min, v + (rand() < 0.5 ? -1 : 1)));
    else if (dim.values.length > 1 && rand() < 0.5) {
      const others = dim.values.filter((x) => x !== v);
      config[key] = others[Math.floor(rand() * others.length)];
    }
  }
  return version(config, implementationId, champion.id);
}

async function run({ rule, fn, d, sigma, gen, seed }) {
  const id = `search-bench-v1-${rule}-${fn}-d${d}-s${sigma}-${gen}-${seed}`;
  const optRand = rng(seed * 7919);
  const optimum = Array.from({ length: d }, () => (optRand() < 0.5 ? -1 : 1) * (1 + 2 * optRand()));
  const keys = Array.from({ length: d }, (_, i) => `x${String(i).padStart(2, "0")}`);
  const space = Object.fromEntries(keys.map((k) => [k, { type: "float", min: -5, max: 5, initial: 0 }]));
  const trueF = (config) => {
    const z = keys.map((k, i) => config[k] - optimum[i] + (fn === "rosenbrock" ? 1 : 0));
    return FUNCTIONS[fn](z);
  };
  const { adapter, plan } = createOptimizer({
    space, seed,
    metrics: [{ name: "q", direction: "higher", weight: 1, bounds: { min: 0, max: 1 } }],
    decision: { mode: rule },
    samplesPerTrial: CASES,
    budget: { trials: ROUNDS },
    recovery: "repeatable",
    implementation: { bench: "search-bench-v1", generator: gen, fn, d, sigma, optimum },
    async execute(config, { sample }) {
      const noise = sigma * gauss(rng(hashSeed({ seed, sample, config })));
      const q = 1 / (1 + Math.log1p(trueF(config)));
      return { output: { q: Math.min(1, Math.max(0, q + noise)) }, cost: 0 };
    },
  });
  const implId = digest(adapter.implementation);
  const bench = gen === "local"
    ? { ...adapter, propose: (champion, history, p) => localPropose(p.space, implId, champion, history.length, p.seed) }
    : adapter;
  const h = learnerHarness(`${DIR}/${id}.db`, bench);
  try {
    await h.startOrResume(id, plan);
    const state = await h.wait(id);
    return { f: trueF(state.champion.config), accepted: state.trials.filter((t) => t.accepted).length };
  } finally { await h.close(); }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
const fmt = (xs) => `${mean(xs).toPrecision(3)} ± ${se(xs).toPrecision(2)}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(DIR, { recursive: true });
  const rows = [];
  for (const rule of ["heuristic", "bounded"]) for (const sigma of [0.01, 0.1]) for (const fn of Object.keys(FUNCTIONS)) for (const d of [2, 5, 10]) {
    const res = { random: [], local: [] };
    for (let seed = 1; seed <= SEEDS; seed++) for (const gen of ["random", "local"]) res[gen].push(await run({ rule, fn, d, sigma, gen, seed }));
    const fA = res.random.map((r) => r.f), fB = res.local.map((r) => r.f);
    const diff = fB.map((b, i) => b - fA[i]);
    const verdict = mean(diff) < -2 * se(diff) ? "B wins" : mean(diff) > 2 * se(diff) ? "B loses" : "tie";
    const row = { rule, sigma, fn, d, fA, fB, acceptedA: res.random.map((r) => r.accepted), acceptedB: res.local.map((r) => r.accepted),
      diffMean: mean(diff), diffSE: se(diff), verdict };
    rows.push(row);
    console.log(`| ${rule} | ${fn} | ${d} | ${sigma} | ${fmt(fA)} | ${fmt(fB)} | ${fmt(diff)} | ${mean(row.acceptedA).toFixed(1)} | ${mean(row.acceptedB).toFixed(1)} | ${verdict} |`);
  }
  writeFileSync(`${DIR}/results.json`, JSON.stringify(rows, null, 2));

  const primary = rows.filter((r) => r.rule === "heuristic");
  const perSigma = [0.01, 0.1].map((s) => primary.filter((r) => r.sigma === s && r.d >= 5 && r.verdict === "B wins").length);
  const losses = primary.filter((r) => r.verdict === "B loses").length;
  console.log(`B wins in d=5,10 cells: σ=0.01 ${perSigma[0]}/6, σ=0.1 ${perSigma[1]}/6; B losses: ${losses}`);
  console.log(`Hypothesis ${perSigma.every((n) => n >= 4) && losses === 0 ? "HOLDS" : "DOES NOT HOLD"}`);
}
