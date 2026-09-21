// Structural search space for Connect-4: MCTS params + component priors.
// Same contract as examples/tictactoe/strategy.mjs. Pure, finite JSON.
import { readFileSync } from "node:fs";
import { digest } from "mutara";
import { COLS, rng, legalMoves, apply, winner, isDraw, plies } from "./game.mjs";

export const implementation = {
  game: "connect4-5x5-v1",
  rules: "5x5 win4, X=version-policy(mcts+prior), O=mcts-fixed-baseline, starter by sample parity, split rng streams",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "strategy.mjs": readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

const other = (p) => (p === "X" ? "O" : "X");
const CENTER = (COLS - 1) / 2; // 2

export const FEATURES = {
  takeWin: (board, col, player) => (winner(apply(board, col, player)) === player ? 1 : 0),
  blockWin: (board, col, player) => {
    const o = other(player);
    // Column blocks if the opponent could win by playing there (legal moves only).
    return winner(apply(board, col, o)) === o ? 1 : 0;
  },
  center: (_b, col) => (col === CENTER ? 1 : 0),
  edge: (_b, col) => (col === 0 || col === COLS - 1 ? 1 : 0),
};
export const CONDITIONS = {
  always: () => true,
  early: (n) => n < 8,
  late: (n) => n >= 8,
};

const LEVELS = [0, 0.25, 0.5, 1, 2];
const MAX_COMPONENTS = 4;

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

function priorOf(version, board, col, player) {
  const n = plies(board);
  let s = 0;
  for (const c of version.components) {
    if (CONDITIONS[c.when](n)) s += c.weight * FEATURES[c.feature](board, col, player);
  }
  return s;
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
  for (let d = 0; d < 60; d++) {
    const w = winner(b);
    if (w) return w === root ? 1 : 0;
    if (isDraw(b)) return 0.5;
    b = apply(b, rolloutChoice(b, t, version, rand), t);
    t = other(t);
  }
  return 0.5;
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

/** Plain UCT baseline (uniform rollouts) for the fixed opponent. */
export function baselineMove(board, player, rand, params = INITIAL_PARAMS) {
  const moves = legalMoves(board);
  if (moves.length <= 1) return moves[0];
  const stats = new Map(moves.map((m) => [m, { visits: 0, wins: 0 }]));
  for (let s = 0; s < params.simulations; s++) {
    let move = moves.find((m) => stats.get(m).visits === 0);
    if (move === undefined) {
      const total = moves.reduce((n, m) => n + stats.get(m).visits, 0);
      let best = -Infinity;
      move = moves[0];
      for (const m of moves) {
        const st = stats.get(m);
        const ucb = st.wins / st.visits + params.uctC * Math.sqrt(Math.log(total) / st.visits);
        if (ucb > best) {
          best = ucb;
          move = m;
        }
      }
    }
    let b = apply(board, move, player);
    let t = other(player);
    let score = 0.5;
    for (let d = 0; d < 60; d++) {
      const w = winner(b);
      if (w) {
        score = w === player ? 1 : 0;
        break;
      }
      if (isDraw(b)) break;
      const ms = legalMoves(b);
      b = apply(b, ms[Math.floor(rand() * ms.length)], t);
      t = other(t);
    }
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

export function proposeComponents(champion, round, seed) {
  const random = rng((seed + round * 0x9e3779b9) | 0);
  const draw = (xs) => xs[Math.floor(random() * xs.length)];
  const features = Object.keys(FEATURES);
  const conditions = Object.keys(CONDITIONS);
  const terms = champion.components.map((c) => ({ ...c }));
  const mutate = () => {
    const feature = draw(features);
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
