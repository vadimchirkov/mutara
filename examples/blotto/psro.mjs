// Experiment 5: PSRO on Colonel Blotto inside a Mutara adapter, $0.
// propose = exact best response to the champion's mix + regret-matching
// meta-solver over the population. Criteria are fixed in README.md.
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { duel, pureStrategies, FIELDS, SOLDIERS } from "./blotto.mjs";

export const implementation = { game: "blotto-psro-v1", file: readFileSync(new URL(import.meta.url), "utf8") };
const implementationId = digest(implementation);

export function psroVersion(population, weights, parentId = null) {
  const content = { parentId, implementationId, population, weights };
  return Object.freeze({ id: digest(content), ...content });
}
const validDist = (d) => Array.isArray(d) && d.length === FIELDS && d.every((x) => Number.isSafeInteger(x) && x >= 0) &&
  d.reduce((a, b) => a + b, 0) === SOLDIERS;
function checkVersion(v) {
  if (!v || !Array.isArray(v.population) || v.population.length < 1 || !v.population.every(validDist) ||
      !Array.isArray(v.weights) || v.weights.length !== v.population.length || !v.weights.every((w) => w >= 0) ||
      Math.abs(v.weights.reduce((a, b) => a + b, 0) - 1) > 1e-5 ||
      psroVersion(v.population, v.weights, v.parentId ?? null).id !== v.id) throw new Error("Invalid PSRO version");
}

// Best pure response to a weighted mix. Ties go to the first in pureStrategies() order;
// strategies in `exclude` (keys "a,b,c,d,e") are skipped.
export function bestResponse(population, weights, exclude = new Set()) {
  let best = null, value = -Infinity;
  for (const p of pureStrategies()) {
    if (exclude.has(p.join())) continue;
    let v = 0;
    for (let j = 0; j < population.length; j++) if (weights[j]) v += weights[j] * duel(p, population[j]);
    if (v > value + 1e-12) { best = p; value = v; }
  }
  return { best, value };
}
export const weightedExploitability = (population, weights) => bestResponse(population, weights).value;

// Regret matching for both players of a symmetric zero-sum matrix game
// (M[i][j] = payoff of i against j). Returns the mean of both average strategies.
export function regretMatching(M, iterations = 2000) {
  const n = M.length;
  const regrets = [new Array(n).fill(0), new Array(n).fill(0)];
  const sums = [new Array(n).fill(0), new Array(n).fill(0)];
  const strategy = (r) => {
    const pos = r.map((x) => Math.max(0, x)), total = pos.reduce((a, b) => a + b, 0);
    return total > 0 ? pos.map((x) => x / total) : new Array(n).fill(1 / n);
  };
  for (let t = 0; t < iterations; t++) {
    const xs = regrets.map(strategy);
    for (let p = 0; p < 2; p++) {
      const other = xs[1 - p];
      const u = M.map((row) => row.reduce((a, m, j) => a + m * other[j], 0));
      const value = u.reduce((a, x, i) => a + x * xs[p][i], 0);
      for (let i = 0; i < n; i++) { regrets[p][i] += u[i] - value; sums[p][i] += xs[p][i]; }
    }
  }
  return sums[0].map((s, i) => (s + sums[1][i]) / (2 * iterations));
}

function normalize(weights) {
  const rounded = weights.map((w) => Math.round(w * 1e6) / 1e6);
  const total = rounded.reduce((a, b) => a + b, 0);
  return rounded.map((w) => w / total);
}

function propose(champion) {
  const { population, weights } = champion;
  const present = new Set(population.map((d) => d.join()));
  const next = [...population, bestResponse(population, weights, present).best];
  const M = next.map((a) => next.map((b) => duel(a, b)));
  return psroVersion(next, normalize(regretMatching(M)), champion.id);
}

export const adapter = {
  implementation,
  recovery: "repeatable",
  validatePlan(p) {
    if (!["psro", "gated"].includes(p.rule) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
        !Number.isSafeInteger(p.seed)) throw new Error("Invalid PSRO plan");
    checkVersion(p.initial);
  },
  validateVersion: checkVersion,
  limits: (p) => ({ executions: p.rounds, cost: 0 }),
  propose: (champion) => propose(champion),
  jobs: (champion, candidate) => [{ key: "exploitability", input: {
    candidate: { population: candidate.population, weights: candidate.weights },
    champion: { population: champion.population, weights: champion.weights },
  }, costLimit: 0 }],
  async execute({ input: { candidate, champion } }) {
    return { output: {
      candidate: weightedExploitability(candidate.population, candidate.weights),
      champion: weightedExploitability(champion.population, champion.weights),
      support: candidate.weights.filter((w) => w > 0.01).length,
    }, cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess: (runs, plan) => {
    const evaluation = runs[0].observation.data;
    const accepted = plan.rule === "psro" || evaluation.candidate <= evaluation.champion + 1e-9;
    return { evaluation, decision: { accepted, reason: `exploitability ${evaluation.champion.toFixed(4)} -> ${evaluation.candidate.toFixed(4)}` } };
  },
};
