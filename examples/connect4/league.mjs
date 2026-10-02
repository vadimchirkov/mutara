// League adapter for Connect-4: the candidate plays the current champion plus
// a league of frozen past champions. The league is in the plan, frozen per
// link (`jobs` gets no history and `propose` stays pure). Versions, proposer,
// game and plan checks are shared with self-play; only the opponents and the
// rule change. Criteria: README.md, "League vs self-play".
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { checkVersion, proposeComponents } from "./strategy.mjs";
import { adapter as selfplay, buildSpPlan, playGame } from "./selfplay.mjs";

export const implementation = {
  game: "connect4-league-v1",
  rules: "5x5 win4, candidate vs current champion + plan league, games split by seed pairs, remainder to champion, absolute 0.5 par",
  files: Object.fromEntries(["game.mjs", "strategy.mjs", "selfplay.mjs", "league.mjs"]
    .map((f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), "utf8")])),
};
export const implementationId = digest(implementation);

export const opponentsOf = (champion, plan) =>
  [champion, ...plan.league].filter((v, i, all) => all.findIndex((w) => w.id === v.id) === i);

// Seed pairs (one X game, one O game by parity) split evenly over opponents;
// the remainder pairs go to the current champion, opponent 0.
export function assign(seeds, k) {
  const pairs = seeds.length / 2;
  const base = Math.floor(pairs / k);
  const extra = pairs - base * k;
  return seeds.map((_, i) => {
    const pair = Math.floor(i / 2);
    return pair < base + extra ? 0 : 1 + Math.floor((pair - base - extra) / base);
  });
}

export function evaluate(candidate, opponents, seeds) {
  const who = assign(seeds, opponents.length);
  return seeds.map((seed, i) => ({ seed, opponent: opponents[who[i]].id, score: playGame(candidate, opponents[who[i]], seed) }));
}

function validatePlan(p) {
  selfplay.validatePlan(p);
  if (!Array.isArray(p.league) || p.league.length < 1 || p.trainingSeeds.length % 2 || p.validationSeeds.length % 2 ||
      !(p.margin >= 0 && p.margin < 0.5) || Math.min(p.trainingSeeds.length, p.validationSeeds.length) / 2 < p.league.length + 1) {
    throw new Error("Invalid league plan");
  }
  p.league.forEach(checkVersion);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function decideCandidate(e, plan) {
  for (const [episodes, seeds] of [[e.candidateTraining, plan.trainingSeeds], [e.candidateValidation, plan.validationSeeds]]) {
    if (!Array.isArray(episodes) || episodes.length !== seeds.length ||
        episodes.some((r, i) => r.seed !== seeds[i] || typeof r.opponent !== "string" ||
          typeof r.score !== "number" || r.score < 0 || r.score > 1)) {
      throw new Error("Invalid or unpaired evaluation");
    }
  }
  const train = mean(e.candidateTraining.map((r) => r.score)) - 0.5;
  const validation = mean(e.candidateValidation.map((r) => r.score)) - 0.5;
  const wins = e.candidateValidation.filter((r) => r.score === 1).length;
  const losses = e.candidateValidation.filter((r) => r.score === 0).length;
  const perOpponent = [...new Set(e.candidateValidation.map((r) => r.opponent))]
    .map((id) => mean(e.candidateValidation.filter((r) => r.opponent === id).map((r) => r.score)));
  const worst = Math.min(...perOpponent);
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses &&
    worst >= 0.5 - plan.margin;
  return { accepted, reason: `train edge=${train.toFixed(3)}, validation edge=${validation.toFixed(3)}, wins=${wins}, losses=${losses}, worst opponent=${worst.toFixed(3)} of ${perOpponent.length}` };
}

export const adapter = {
  ...selfplay,
  implementation: { ...implementation, adapter: implementation.files["league.mjs"] },
  validatePlan,
  propose: (champion, history, p) => proposeComponents(champion, history.length, p.seed),
  jobs: (champion, candidate, p) => {
    const opponents = opponentsOf(champion, p);
    return [
      { key: "candidateTraining", input: { candidate, opponents, seeds: p.trainingSeeds }, costLimit: 0 },
      { key: "candidateValidation", input: { candidate, opponents, seeds: p.validationSeeds }, costLimit: 0 },
    ];
  },
  async execute(job) {
    const { candidate, opponents, seeds } = job.input;
    checkVersion(candidate);
    opponents.forEach(checkVersion);
    return { output: evaluate(candidate, opponents, seeds), cost: 0 };
  },
  assess(runs, plan) {
    const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation.data]));
    return { evaluation, decision: decideCandidate(evaluation, plan) };
  },
};

export const buildLeaguePlan = ({ league, margin = 0.1, ...rest }) => ({ ...buildSpPlan(rest), league, margin });
