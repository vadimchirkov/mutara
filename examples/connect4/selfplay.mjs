// Self-play adapter for Connect-4: the candidate fights the reigning champion,
// both seats (candidate seat by sample parity, X always starts). No fixed
// baseline: the target moves. Versions and proposer are shared with the
// component search (same shape, same checks); only the opponent changes.
// Cycle risk (rock-paper-scissors) is real — fresh seeds per link plus final
// cross-checks vs the fixed baseline and deep MCTS guard it. A league of past
// champions would be the next step, not this file.
import { readFileSync } from "node:fs";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";
import {
  checkVersion, proposeComponents, versionMove,
} from "./strategy.mjs";
import { strategyVersion, INITIAL_PARAMS } from "./strategy.mjs";
import { digest } from "mutara";

export const implementation = {
  game: "connect4-sp-v1",
  rules: "5x5 win4, candidate vs champion both seats, candidate seat by sample parity, X starts, split seat rng streams",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "strategy.mjs": readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8"),
    "selfplay.mjs": readFileSync(new URL("./selfplay.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

// Handoff: the c4-comp-v2 champion, rebuilt in the shared version space.
export const v2Champion = () => strategyVersion(INITIAL_PARAMS, null, [
  { feature: "blockWin", weight: 0.5, when: "always" },
  { feature: "center", weight: 1, when: "always" },
  { feature: "takeWin", weight: 0.5, when: "always" },
]);

// Score from the candidate's view. Streams split by seat, not by policy.
function playGame(candidate, champion, sample) {
  const randX = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randO = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  const candidateX = sample % 2 === 0;
  let board = emptyBoard();
  let toMove = "X";
  while (true) {
    const w = winner(board);
    if (w) {
      const xScore = w === "X" ? 1 : 0;
      return candidateX ? xScore : 1 - xScore;
    }
    if (isDraw(board)) return 0.5;
    const version = toMove === "X"
      ? (candidateX ? candidate : champion)
      : (candidateX ? champion : candidate);
    board = apply(board, versionMove(version, board, toMove, toMove === "X" ? randX : randO), toMove);
    toMove = toMove === "X" ? "O" : "X";
  }
}

const evaluate = (candidate, champion, seeds) =>
  seeds.map((seed) => ({ seed, score: playGame(candidate, champion, seed) }));

const validSeeds = (s) => Array.isArray(s) && s.length > 0 && new Set(s).size === s.length && s.every(Number.isSafeInteger);

function validatePlan(p) {
  if (!Number.isSafeInteger(p.seed) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
      !Number.isFinite(p.minimumGain) || p.minimumGain <= 0 ||
      !validSeeds(p.trainingSeeds) || !validSeeds(p.validationSeeds) ||
      p.trainingSeeds.some((s) => p.validationSeeds.includes(s))) {
    throw new Error("Invalid self-play plan or overlapping seed sets");
  }
  checkVersion(p.initial);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// No mirror baseline: the absolute 0.5 line is the par. Both seats included,
// so 0.5 is exact par by symmetry.
export function decideCandidate(e, plan) {
  for (const [episodes, seeds] of [
    [e.candidateTraining, plan.trainingSeeds], [e.candidateValidation, plan.validationSeeds],
  ]) {
    if (!Array.isArray(episodes) || episodes.length !== seeds.length ||
        episodes.some((r, i) => r.seed !== seeds[i] || typeof r.score !== "number" || r.score < 0 || r.score > 1)) {
      throw new Error("Invalid or unpaired evaluation");
    }
  }
  const train = mean(e.candidateTraining.map((r) => r.score)) - 0.5;
  const deltas = e.candidateValidation.map((r) => r.score - 0.5);
  const validation = mean(deltas);
  const wins = e.candidateValidation.filter((r) => r.score === 1).length;
  const losses = e.candidateValidation.filter((r) => r.score === 0).length;
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train edge=${train.toFixed(3)}, validation edge=${validation.toFixed(3)}, wins=${wins}/${deltas.length}, losses=${losses}/${deltas.length}` };
}

export const adapter = {
  implementation: {
    ...implementation,
    adapter: readFileSync(new URL("./selfplay.mjs", import.meta.url), "utf8"),
  },
  recovery: "repeatable",
  validatePlan,
  validateVersion: (v) => checkVersion(v),
  limits: (p) => ({ executions: p.rounds * 2, cost: 0 }),
  propose: (champion, history, p) => proposeComponents(champion, history.length, p.seed),
  jobs: (champion, candidate, p) => [
    { key: "candidateTraining", input: { candidate, champion, seeds: p.trainingSeeds }, costLimit: 0 },
    { key: "candidateValidation", input: { candidate, champion, seeds: p.validationSeeds }, costLimit: 0 },
  ],
  async execute(job) {
    const { candidate, champion, seeds } = job.input;
    checkVersion(candidate);
    checkVersion(champion);
    return { output: evaluate(candidate, champion, seeds), cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess(runs, plan) {
    const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation.data]));
    return { evaluation, decision: decideCandidate(evaluation, plan) };
  },
};

export function buildSpPlan({ rounds = 10, seed = 7919, minimumGain = 0.03, initial = v2Champion(), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 64 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 64 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, initial };
}

export { evaluate, playGame };
