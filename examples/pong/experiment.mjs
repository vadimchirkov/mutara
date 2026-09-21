// Pong learning adapter: version (X) vs deadband tracker (O), first to 5,
// 12000-frame cap counts as a draw. Split streams: decisions and serves use
// independent rng, so a policy that decides more often does not shift serves.
import { readFileSync } from "node:fs";
import { initialState, step, isTerminal, winner, serve, rng } from "./game.mjs";
import {
  implementation, checkVersion, initialVersion,
  proposeComponents, versionMove, baselineMove,
} from "./strategy.mjs";

const FRAME_SKIP = 4;
const FRAME_CAP = 12000;

function playGame(policy, sample) {
  const randDecide = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randServe = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let state = initialState(randServe);
  let ax = 0;
  let ao = 0;
  for (let f = 0; f < FRAME_CAP; f++) {
    if (f % FRAME_SKIP === 0) {
      ax = policy(state, randDecide);
      ao = baselineMove(state);
    }
    state = step(state, ax, ao);
    if (state.scored) {
      if (isTerminal(state)) break;
      state = serve(state, randServe);
    }
  }
  const w = winner(state);
  if (w) return w === "X" ? 1 : 0;
  return 0.5;
}

const policyOf = (version) => (state, rand) => versionMove(version, state, rand);
const evaluate = (version, seeds) => seeds.map((seed) => ({ seed, score: playGame(policyOf(version), seed) }));

const validSeeds = (s) => Array.isArray(s) && s.length > 0 && new Set(s).size === s.length && s.every(Number.isSafeInteger);

function validatePlan(p) {
  if (!Number.isSafeInteger(p.seed) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
      !Number.isFinite(p.minimumGain) || p.minimumGain <= 0 ||
      !validSeeds(p.trainingSeeds) || !validSeeds(p.validationSeeds) ||
      p.trainingSeeds.some((s) => p.validationSeeds.includes(s))) {
    throw new Error("Invalid experiment plan or overlapping seed sets");
  }
  checkVersion(p.initial);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function decideCandidate(e, plan) {
  for (const [episodes, seeds] of [
    [e.baselineTraining, plan.trainingSeeds], [e.candidateTraining, plan.trainingSeeds],
    [e.baselineValidation, plan.validationSeeds], [e.candidateValidation, plan.validationSeeds],
  ]) {
    if (!Array.isArray(episodes) || episodes.length !== seeds.length ||
        episodes.some((r, i) => r.seed !== seeds[i] || typeof r.score !== "number" || r.score < 0 || r.score > 1)) {
      throw new Error("Invalid or unpaired evaluation");
    }
  }
  const train = mean(e.candidateTraining.map((r, i) => r.score - e.baselineTraining[i].score));
  const deltas = e.candidateValidation.map((r, i) => r.score - e.baselineValidation[i].score);
  const validation = mean(deltas);
  const wins = deltas.filter((n) => n > 0).length;
  const losses = deltas.filter((n) => n < 0).length;
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train edge=${train.toFixed(3)}, validation edge=${validation.toFixed(3)}, wins=${wins}/${deltas.length}, losses=${losses}/${deltas.length}` };
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
  propose: (champion, history, p) => proposeComponents(champion, history.length, p.seed),
  jobs: (champion, candidate, p) => [
    { key: "baselineTraining", input: { version: champion, seeds: p.trainingSeeds }, costLimit: 0 },
    { key: "candidateTraining", input: { version: candidate, seeds: p.trainingSeeds }, costLimit: 0 },
    { key: "baselineValidation", input: { version: champion, seeds: p.validationSeeds }, costLimit: 0 },
    { key: "candidateValidation", input: { version: candidate, seeds: p.validationSeeds }, costLimit: 0 },
  ],
  async execute(job) {
    const { version, seeds } = job.input;
    checkVersion(version);
    return { output: evaluate(version, seeds), cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess(runs, plan) {
    const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation.data]));
    return { evaluation, decision: decideCandidate(evaluation, plan) };
  },
};

export function buildPlan({ rounds = 4, seed = 7919, minimumGain = 0.05, initial = initialVersion(), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 32 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 32 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, initial };
}

export { evaluate, playGame };
