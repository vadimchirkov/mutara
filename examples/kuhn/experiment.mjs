// Custom Adapter for Kuhn policy search. Same shape as the sibling
// experiments: journaled jobs, train/validation gate. Difference: evaluation
// is exact EV over the 6 deals (no seeds, no noise), train vs HONEST and
// validation vs TRICKY (fixed, disjoint). Overfitting a single fixed opponent
// is possible — the held-out (exploitability) tells the truth.
import { readFileSync } from "node:fs";
import { evPerDeal } from "./game.mjs";
import {
  implementation, checkVersion, initialVersion,
  proposePolicy, HONEST, TRICKY,
} from "./strategy.mjs";

// Version plays both seats; each seat is scored over all 6 deals from the
// version's own view (P2 seat values flipped). 12 numbers, all dims live.
const evaluate = (version, opponent) => {
  const asP1 = evPerDeal(version.policy, opponent);
  const asP2 = evPerDeal(opponent, version.policy).map((v) => -v);
  const perDeal = [...asP1, ...asP2];
  return { ev: perDeal.reduce((a, b) => a + b, 0), perDeal };
};

function validatePlan(p) {
  if (!Number.isSafeInteger(p.seed) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
      !Number.isFinite(p.minimumGain) || p.minimumGain <= 0) {
    throw new Error("Invalid experiment plan");
  }
  checkVersion(p.initial);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function decideCandidate(e, plan) {
  for (const key of ["baselineTraining", "candidateTraining", "baselineValidation", "candidateValidation"]) {
    if (!e[key] || !Array.isArray(e[key].perDeal) || e[key].perDeal.length !== 12 ||
        e[key].perDeal.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new Error("Invalid or unpaired evaluation");
    }
  }
  const train = mean(e.candidateTraining.perDeal) - mean(e.baselineTraining.perDeal);
  const deltas = e.candidateValidation.perDeal.map((v, i) => v - e.baselineValidation.perDeal[i]);
  const validation = mean(deltas);
  const wins = deltas.filter((n) => n > 0).length;
  const losses = deltas.filter((n) => n < 0).length;
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train delta=${train.toFixed(4)}, validation delta=${validation.toFixed(4)}, wins=${wins}/12, losses=${losses}/12` };
}

export const adapter = {
  implementation: {
    ...implementation,
    adapter: readFileSync(new URL("./experiment.mjs", import.meta.url), "utf8"),
  },
  recovery: "repeatable",
  validatePlan,
  validateVersion: (v) => checkVersion(v),
  limits: (p) => ({ executions: p.rounds * 4, cost: 0 }),
  propose: (champion, history, p) => proposePolicy(champion, history.length, p.seed),
  jobs: (champion, candidate, p) => [
    { key: "baselineTraining", input: { version: champion, opponent: HONEST }, costLimit: 0 },
    { key: "candidateTraining", input: { version: candidate, opponent: HONEST }, costLimit: 0 },
    { key: "baselineValidation", input: { version: champion, opponent: TRICKY }, costLimit: 0 },
    { key: "candidateValidation", input: { version: candidate, opponent: TRICKY }, costLimit: 0 },
  ],
  async execute(job) {
    const { version, opponent } = job.input;
    checkVersion(version);
    return { output: evaluate(version, opponent), cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess(runs, plan) {
    const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation.data]));
    return { evaluation, decision: decideCandidate(evaluation, plan) };
  },
};

export function buildPlan({ rounds = 48, seed = 7919, minimumGain = 0.002, initial = initialVersion() } = {}) {
  return { rounds, seed, minimumGain, initial };
}

export { evaluate };
