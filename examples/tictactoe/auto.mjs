// Machine-dictionary selection: same engine, same budget shape, same gate as
// the human run (methodology parity — the held-out decides, not the gate).
// Differences, all documented: 14 machine features (auto-features.mjs),
// staged proposer (rounds 0..13 screen one feature each, then free mutations),
// bounded lower bound reported alongside the heuristic reason (vacuous at
// n=48 — Hoeffding penalty ~0.5 dwarfs realistic gains; honest admission,
// not a gate). Self-contained: strategy.mjs untouched, old IDs stay valid.
import { readFileSync } from "node:fs";
import { digest, boundedDecision } from "mutara";
import { emptyBoard, winner, isDraw, apply, rng, legalMoves } from "./game.mjs";
import { mctsMove } from "./mcts.mjs";
import { FEATURES } from "./auto-features.mjs";

export const implementation = {
  game: "tictactoe-auto-v1",
  rules: "3x3, X=version-policy(mcts+machine-prior), O=mcts-fixed-baseline, starter by sample parity, split rng streams, staged screening",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "mcts.mjs": readFileSync(new URL("./mcts.mjs", import.meta.url), "utf8"),
    "auto-features.mjs": readFileSync(new URL("./auto-features.mjs", import.meta.url), "utf8"),
    "auto.mjs": readFileSync(new URL("./auto.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

const CONDITIONS = {
  always: () => true,
  early: (plies) => plies < 4,
  late: (plies) => plies >= 4,
};
const FEATURE_NAMES = Object.keys(FEATURES);
const LEVELS = [0, 0.25, 0.5, 1, 2];
const MAX_COMPONENTS = 5; // same capacity as the human space
const SCREEN_ROUNDS = FEATURE_NAMES.length; // 14
const TOTAL_ROUNDS = SCREEN_ROUNDS + 12; // 26

const other = (p) => (p === "X" ? "O" : "X");

export function strategyVersion(params, parentId = null, components = []) {
  if (!params || typeof params.uctC !== "number" || !Number.isFinite(params.uctC) || params.uctC < 0 || params.uctC > 3) {
    throw new Error("uctC must be a finite number in [0, 3]");
  }
  if (!Number.isSafeInteger(params.simulations) || params.simulations < 10 || params.simulations > 200) {
    throw new Error("simulations must be a safe integer in [10, 200]");
  }
  if (!Array.isArray(components) || components.length > MAX_COMPONENTS ||
      components.some((c) => !c || Object.keys(c).length !== 3 || !Object.hasOwn(FEATURES, c.feature) ||
        !Object.hasOwn(CONDITIONS, c.when) || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > 2) ||
      new Set(components.map((c) => c.feature)).size !== components.length) {
    throw new Error("Invalid strategy components");
  }
  const ordered = { uctC: params.uctC, simulations: params.simulations };
  const terms = components.map((c) => ({ feature: c.feature, weight: c.weight, when: c.when }))
    .sort((a, b) => a.feature.localeCompare(b.feature));
  const content = { parentId, implementationId, params: ordered, components: terms };
  return Object.freeze({ id: digest(content), ...content });
}

export const INITIAL_PARAMS = { uctC: 1.4, simulations: 15 };
export const initialVersion = () => strategyVersion(INITIAL_PARAMS, null, []);

export function checkVersion(v) {
  if (!v || typeof v.id !== "string" || v.implementationId !== implementationId ||
      strategyVersion(v.params, v.parentId ?? null, v.components ?? []).id !== v.id) {
    throw new Error("Strategy artifact changed or uses a different implementation");
  }
}

function priorOf(version, board, move, player) {
  const plies = board.filter(Boolean).length;
  let s = 0;
  for (const c of version.components) {
    if (CONDITIONS[c.when](plies)) s += c.weight * FEATURES[c.feature](board, move, player);
  }
  return s;
}

export function versionMove(version, board, player, rand) {
  checkVersion(version);
  const moves = legalMoves(board);
  if (moves.length <= 1) return moves[0];
  const priors = new Map(moves.map((m) => [m, priorOf(version, board, m, player)]));
  const stats = new Map(moves.map((m) => [m, { visits: 0, wins: 0 }]));
  for (let s = 0; s < version.params.simulations; s++) {
    let move = moves.find((m) => stats.get(m).visits === 0);
    if (move === undefined) {
      const total = moves.reduce((n, m) => n + stats.get(m).visits, 0);
      let best = -Infinity;
      move = moves[0];
      for (const m of moves) {
        const st = stats.get(m);
        const ucb = st.wins / st.visits +
          version.params.uctC * Math.sqrt(Math.log(total) / st.visits) + priors.get(m);
        if (ucb > best) {
          best = ucb;
          move = m;
        }
      }
    }
    const next = apply(board, move, player);
    const score = rolloutFrom(next, other(player), player, rand, version);
    const st = stats.get(move);
    st.visits += 1;
    st.wins += score;
  }
  let bestMove = moves[0];
  let bestVisits = -1;
  for (const m of moves) {
    if (stats.get(m).visits > bestVisits) {
      bestVisits = stats.get(m).visits;
      bestMove = m;
    }
  }
  return bestMove;
}

function rolloutChoice(board, player, version, rand) {
  const moves = legalMoves(board);
  const priors = moves.map((m) => priorOf(version, board, m, player));
  const max = Math.max(...priors);
  if (max > 0 && rand() < 0.75) {
    const best = moves.filter((_, i) => priors[i] === max);
    return best[Math.floor(rand() * best.length)];
  }
  return moves[Math.floor(rand() * moves.length)];
}
function rolloutFrom(board, toMove, root, rand, version) {
  let b = board.slice();
  let t = toMove;
  for (let d = 0; d < 32; d++) {
    const w = winner(b);
    if (w) return w === root ? 1 : 0;
    if (isDraw(b)) return 0.5;
    b = apply(b, rolloutChoice(b, t, version, rand), t);
    t = other(t);
  }
  return 0.5;
}

/** Staged proposer: rounds 0..13 screen feature[r] at 0.5 (deterministic order),
 *  then free single/double mutations. Sync, deterministic, parentId-linked. */
export function proposeComponents(champion, round, seed) {
  void seed;
  const terms = champion.components.map((c) => ({ ...c }));
  if (round < SCREEN_ROUNDS) {
    const feature = FEATURE_NAMES[round];
    if (!terms.some((c) => c.feature === feature)) {
      if (terms.length < MAX_COMPONENTS) terms.push({ feature, weight: 0.5, when: "always" });
    } else {
      const t = terms.find((c) => c.feature === feature);
      const levels = LEVELS.filter((w) => w !== 0 && w !== t.weight);
      t.weight = levels[round % levels.length];
    }
    return strategyVersion(champion.params, champion.id, terms);
  }
  const random = rng((7919 + round * 0x9e3779b9) | 0);
  const draw = (xs) => xs[Math.floor(random() * xs.length)];
  const conditions = Object.keys(CONDITIONS);
  const mutate = () => {
    const feature = draw(FEATURE_NAMES);
    const index = terms.findIndex((c) => c.feature === feature);
    const old = terms[index];
    if (old && round % 3 === 2 && conditions.length > 1) {
      terms[index] = { ...old, when: draw(conditions.filter((w) => w !== old.when)) };
    } else {
      const weight = draw(LEVELS.filter((w) => w !== (old?.weight ?? -1)));
      if (index >= 0) terms.splice(index, 1);
      if (weight) {
        if (terms.length >= MAX_COMPONENTS) return;
        terms.push({ feature, weight, when: old?.when ?? "always" });
      }
    }
  };
  mutate();
  if (round % 4 === 3) mutate();
  return strategyVersion(champion.params, champion.id, terms);
}

// ---- Adapter (same shape as experiment.mjs; gate identical by design) ----
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
    toMove = other(toMove);
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
  const bounded = boundedDecision(deltas, { minimumGain: plan.minimumGain, range: 2, alpha: 0.05, comparisons: plan.rounds });
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > losses;
  return { accepted, reason: `train=${train.toFixed(3)}, valid=${validation.toFixed(3)}, wins=${wins}/48, losses=${losses}/48, bounded[${bounded.reason}]` };
}

export const adapter = {
  implementation: {
    ...implementation,
    adapter: readFileSync(new URL("./auto.mjs", import.meta.url), "utf8"),
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

export function buildAutoPlan({ rounds = TOTAL_ROUNDS, seed = 7919, minimumGain = 0.02, initial = initialVersion(), trainingSeeds, validationSeeds } = {}) {
  trainingSeeds ??= Array.from({ length: 48 }, (_, i) => 101 + i);
  validationSeeds ??= Array.from({ length: 48 }, (_, i) => 1001 + i);
  return { rounds, seed, trainingSeeds, validationSeeds, minimumGain, initial };
}

export { evaluate, playGame, TOTAL_ROUNDS };
