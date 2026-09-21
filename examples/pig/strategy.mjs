// Structural search space for Pig: MCTS params + component priors over
// {roll, hold}. Same contract as ../tictactoe/strategy.mjs. Pure, finite JSON.
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { TARGET, rng, legalMoves, apply, winner } from "./game.mjs";

export const implementation = {
  game: "pig-20-v1",
  rules: "race to 20, X=version-policy(mcts+prior), O=hold-at-7, starter by sample parity, split decision/dice rng streams",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "strategy.mjs": readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

const scores = (state, player) => (player === "X" ? [state.a, state.b] : [state.b, state.a]);

export const FEATURES = {
  takeWin: (state, action, player) => {
    const [me] = scores(state, player);
    return action === "hold" && me + state.turn >= TARGET ? 1 : 0;
  },
  avoidBust: (state, action) => (action === "hold" && state.turn >= 8 ? 1 : 0),
  pressLuck: (state, action) => (action === "roll" && state.turn <= 5 ? 1 : 0),
  chase: (state, action, player) => {
    const [me, opp] = scores(state, player);
    return action === "roll" && me < opp ? 1 : 0;
  },
  protect: (state, action, player) => {
    const [me, opp] = scores(state, player);
    return action === "hold" && me > opp ? 1 : 0;
  },
};
export const CONDITIONS = {
  always: () => true,
  early: (banked) => banked < 12,
  late: (banked) => banked >= 12,
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

const banked = (state) => state.a + state.b;

function priorOf(version, state, action, player) {
  const b = banked(state);
  let s = 0;
  for (const c of version.components) {
    if (CONDITIONS[c.when](b)) s += c.weight * FEATURES[c.feature](state, action, player);
  }
  return s;
}

const die = (rand) => 1 + Math.floor(rand() * 6);

function rolloutChoice(state, player, version, rand) {
  const moves = legalMoves();
  const priors = moves.map((m) => priorOf(version, state, m, player));
  const max = Math.max(...priors);
  if (max > 0 && rand() < 0.75) {
    const best = moves.filter((_, i) => priors[i] === max);
    return best[Math.floor(rand() * best.length)];
  }
  return moves[Math.floor(rand() * moves.length)];
}

function rolloutFrom(state, toMove, root, rand, version) {
  let s = { ...state };
  let t = toMove;
  for (let d = 0; d < 200; d++) {
    const w = winner(s);
    if (w) return w === root ? 1 : 0;
    s = apply(s, rolloutChoice(s, t, version, rand), die(rand));
    t = t === "X" ? "O" : "X";
  }
  return 0.5;
}

/** MCTS over {roll, hold}; chance sampled via rand. Sync, deterministic given rand. */
export function versionMove(version, state, player, rand) {
  checkVersion(version);
  const moves = legalMoves();
  const priors = new Map(moves.map((m) => [m, priorOf(version, state, m, player)]));
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
    const next = apply(state, move, die(rand));
    const score = rolloutFrom(next, player === "X" ? "O" : "X", player, rand, version);
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

/** Fixed hold-at-K baseline. Deterministic; dice come from the caller. */
export const holdAt = (k) => (state, player) => {
  const [me] = scores(state, player);
  if (me + state.turn >= TARGET || state.turn >= k) return "hold";
  return "roll";
};

/** Sync deterministic proposer: single-component mutation, parentId = champion.id. */
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
