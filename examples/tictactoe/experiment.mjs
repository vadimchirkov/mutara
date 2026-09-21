// Custom Adapter: component search with a train/validation gate.
// Follows skills/mutara/references/api.md and examples/alchemy/src/learning/experiment.ts.
// Versions travel inside journaled jobs (replay-safe); no closure state.
import { readFileSync } from "node:fs";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";
import { mctsMove } from "./mcts.mjs";
import {
  implementation, implementationId, initialVersion, checkVersion,
  proposeComponents, versionMove,
} from "./strategy.mjs";

const BASELINE_MCTS = { uctC: 1.4, simulations: 15 };

function playGame(policy, sample) {
  const randMcts = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randOpp = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let board = emptyBoard();
  let toMove = sample % 2 === 0 ? "X" : "O";
  while (true) {
    const w = winner(board);
    if (w) return w === "X" ? 1 : 0;
    if (isDraw(board)) return 0.5;
    const move = toMove === "X"
      ? policy(board, "X", randMcts)
      : mctsMove(board, "O", BASELINE_MCTS, randOpp);
    board = apply(board, move, toMove);
    toMove = toMove === "X" ? "O" : "X";
  }
}

const policyOf = (version) => (board, player, rand) => versionMove(version, board, player, rand);
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
  // Draw-heavy game: most deltas are 0, so Alchemy's wins>half can never fire.
  // Host rule for this domain: gain on both sets and more wins than losses.
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train delta=${train.toFixed(3)}, validation delta=${validation.toFixed(3)}, wins=${wins}/48, losses=${losses}/48` };
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

export function buildPlan({ rounds = 12, seed = 7919, minimumGain = 0.02, initial = initialVersion(), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 48 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 48 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, initial };
}

export { evaluate, playGame };
