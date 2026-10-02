// League adapter for Connect-4: the candidate and the champion both play the
// same frozen past champions on the same seeds and seats (paired). The league
// lives in the version: an accepted candidate inherits the old champion's
// league plus the old champion. Same proposer as self-play and component
// search; only the opponents and the rule change.
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { checkVersion, proposeComponents } from "./strategy.mjs";
import { playGame, v2Champion } from "./selfplay.mjs";

export const implementation = {
  game: "connect4-league-paired-v1",
  rules: "5x5 win4, candidate and champion vs league members, member by seed pair, seat by parity, paired",
  files: Object.fromEntries(["game.mjs", "strategy.mjs", "selfplay.mjs", "league-paired.mjs"]
    .map((f) => [f, readFileSync(new URL(`./${f}`, import.meta.url), "utf8")])),
};
export const implementationId = digest(implementation);

export function leagueVersion(strategy, league = [], parentId = null) {
  const content = { parentId, implementationId, strategy, league };
  return Object.freeze({ id: digest(content), ...content });
}

function checkLeagueVersion(v) {
  if (!v || !Array.isArray(v.league) || v.league.length > 100) throw new Error("Invalid league version");
  checkVersion(v.strategy);
  v.league.forEach(checkVersion);
  if (leagueVersion(v.strategy, v.league, v.parentId ?? null).id !== v.id) throw new Error("League version changed");
}

// The opponents a candidate faces: the champion's league plus the champion.
const opponentsOf = (champion) => [...champion.league, champion.strategy];
// Seeds come in seat pairs (even = X, odd = O), each pair goes to one member.
const memberOf = (i, k) => Math.floor(i / 2) % k;

// Deterministic games, so repeated champion games are served from memory.
// Report counts games actually played.
const cache = new Map();
export const played = { games: 0 };
function game(player, opponent, seed) {
  const key = `${player.id}|${opponent.id}|${seed}`;
  if (!cache.has(key)) {
    played.games += 1;
    cache.set(key, playGame(player, opponent, seed));
  }
  return cache.get(key);
}
const evaluate = (player, opponents, seeds) =>
  seeds.map((seed, i) => ({ seed, member: memberOf(i, opponents.length), score: game(player, opponents[memberOf(i, opponents.length)], seed) }));

const validSeeds = (s) => Array.isArray(s) && s.length > 0 && new Set(s).size === s.length && s.every(Number.isSafeInteger);
function validatePlan(p) {
  if (!Number.isSafeInteger(p.seed) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
      !Number.isFinite(p.minimumGain) || p.minimumGain <= 0 || !(p.margin >= 0) || !(p.alpha > 0 && p.alpha < 1) ||
      !validSeeds(p.trainingSeeds) || !validSeeds(p.validationSeeds) ||
      p.trainingSeeds.some((s) => p.validationSeeds.includes(s))) {
    throw new Error("Invalid league plan or overlapping seed sets");
  }
  checkLeagueVersion(p.initial);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// One-sided normal approximation, H0: mean delta >= -margin.
const normalCdf = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));
function regressionP(deltas, margin) {
  const m = mean(deltas);
  const sd = Math.sqrt(deltas.reduce((a, d) => a + (d - m) ** 2, 0) / Math.max(1, deltas.length - 1));
  if (sd === 0) return m < -margin ? 0 : 1;
  return normalCdf((m + margin) / (sd / Math.sqrt(deltas.length)));
}
// Holm step-down: true if any member's regression survives correction.
export function holmRejects(ps, alpha) {
  const sorted = [...ps].sort((a, b) => a - b);
  return sorted.length > 0 && sorted[0] <= alpha / sorted.length;
}

export function decideCandidate(e, plan) {
  for (const [a, b, seeds] of [
    [e.candidateTraining, e.championTraining, plan.trainingSeeds],
    [e.candidateValidation, e.championValidation, plan.validationSeeds],
  ]) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== seeds.length || b.length !== seeds.length ||
        a.some((r, i) => r.seed !== seeds[i] || b[i].seed !== seeds[i] || r.member !== b[i].member ||
          typeof r.score !== "number" || r.score < 0 || r.score > 1)) {
      throw new Error("Invalid or unpaired evaluation");
    }
  }
  const train = mean(e.candidateTraining.map((r, i) => r.score - e.championTraining[i].score));
  const deltas = e.candidateValidation.map((r, i) => ({ member: r.member, d: r.score - e.championValidation[i].score }));
  const validation = mean(deltas.map((x) => x.d));
  const wins = deltas.filter((x) => x.d > 0).length;
  const losses = deltas.filter((x) => x.d < 0).length;
  const members = [...new Set(deltas.map((x) => x.member))];
  const ps = members.map((m) => regressionP(deltas.filter((x) => x.member === m).map((x) => x.d), plan.margin));
  const violation = holmRejects(ps, plan.alpha);
  const accepted = !violation && train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return {
    accepted,
    reason: `${violation ? "violation: member regression, " : ""}train delta=${train.toFixed(3)}, validation delta=${validation.toFixed(3)}, wins=${wins}, losses=${losses}, members=${members.length}, min p=${Math.min(...ps).toFixed(3)}`,
  };
}

export const adapter = {
  implementation: { ...implementation, adapter: implementation.files["league-paired.mjs"] },
  recovery: "repeatable",
  validatePlan,
  validateVersion: checkLeagueVersion,
  limits: (p) => ({ executions: p.rounds * 4, cost: 0 }),
  propose: (champion, history, p) =>
    leagueVersion(proposeComponents(champion.strategy, history.length, p.seed), opponentsOf(champion), champion.id),
  jobs: (champion, candidate, p) => {
    const opponents = opponentsOf(champion);
    return [
      ["candidateTraining", candidate, p.trainingSeeds], ["championTraining", champion, p.trainingSeeds],
      ["candidateValidation", candidate, p.validationSeeds], ["championValidation", champion, p.validationSeeds],
    ].map(([key, v, seeds]) => ({ key, input: { player: v.strategy, opponents, seeds }, costLimit: 0 }));
  },
  async execute(job) {
    const { player, opponents, seeds } = job.input;
    checkVersion(player);
    opponents.forEach(checkVersion);
    return { output: evaluate(player, opponents, seeds), cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess(runs, plan) {
    const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation.data]));
    return { evaluation, decision: decideCandidate(evaluation, plan) };
  },
};

export function buildLeaguePlan({ rounds = 8, seed = 7919, minimumGain = 0.03, margin = 0.1, alpha = 0.05,
  initial = leagueVersion(v2Champion()), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 64 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 64 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, margin, alpha, initial };
}
