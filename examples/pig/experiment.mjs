// Custom Adapter for Pig component search. Same contract as
// ../tictactoe/experiment.mjs: journaled jobs, train/validation gate.
// Split streams: decisions and dice use independent rng, so a candidate that
// burns more decision randomness does not shift the dice.
import { readFileSync } from "node:fs";
import { initialState, winner, apply, rng } from "./game.mjs";
import {
  implementation, checkVersion, initialVersion,
  proposeComponents, versionMove, holdAt,
} from "./strategy.mjs";

const BASELINE = holdAt(7);
const die = (rand) => 1 + Math.floor(rand() * 6);

function playGame(policy, sample) {
  const randDecide = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randDice = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let state = initialState();
  if (sample % 2 === 1) state = { ...state, toMove: "O" };
  while (true) {
    const w = winner(state);
    if (w) return w === "X" ? 1 : 0;
    const move = state.toMove === "X"
      ? policy(state, "X", randDecide)
      : BASELINE(state, "O");
    state = apply(state, move, die(randDice));
  }
}

const policyOf = (version) => (state, player, rand) => versionMove(version, state, player, rand);
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
  // No draws in Pig: every delta is ±1, so wins+losses = all games.
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train delta=${train.toFixed(3)}, validation delta=${validation.toFixed(3)}, wins=${wins}/${deltas.length}, losses=${losses}/${deltas.length}` };
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

export function buildPlan({ rounds = 10, seed = 7919, minimumGain = 0.02, initial = initialVersion(), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 48 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 48 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, initial };
}

export { evaluate, playGame };
