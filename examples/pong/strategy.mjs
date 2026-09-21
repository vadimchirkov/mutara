// Reactive Pong policy: no tree search (a game is ~1600 decisions; MCTS would
// multiply the 0.15 ms/game cost by ~1000×). Version = weighted components
// voting for {up, stay, down} each decision frame. X always learns, O is the
// fixed deadband tracker. Pure, deterministic, finite JSON.
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { COURT, PADDLE_H, rng } from "./game.mjs";

export const implementation = {
  game: "pong-reactive-v1",
  rules: "X=version-policy(reactive), O=deadband-tracker, frame skip 4, first to 5, cap 12000 frames",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "strategy.mjs": readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

const ACTIONS = [-1, 0, 1];
const approaching = (state) => state.ball.vx < 0;

// Predicted ball y when it reaches the left paddle plane (straight lines,
// walls mirror). NaN-safe: clamped to court.
function interceptY(state) {
  const { x, y, vx, vy } = state.ball;
  if (vx >= 0) return y;
  const t = (x - 3) / -vx;
  let yy = y + vy * t;
  const period = 2 * COURT.h;
  yy = ((yy % period) + period) % period;
  return yy > COURT.h ? period - yy : yy;
}

export const FEATURES = {
  // Move toward the ball while it approaches.
  trackBall: (state, action) => {
    if (!approaching(state)) return 0;
    const dy = state.ball.y - state.paddleX;
    if (Math.abs(dy) < 1.5) return action === 0 ? 1 : 0;
    return (dy > 0 ? 1 : -1) === action ? 1 : 0;
  },
  // Drift back to center while the ball recedes.
  retreatCenter: (state, action) => {
    if (approaching(state)) return 0;
    const dy = COURT.h / 2 - state.paddleX;
    if (Math.abs(dy) < 1.5) return action === 0 ? 1 : 0;
    return (dy > 0 ? 1 : -1) === action ? 1 : 0;
  },
  // Move toward the predicted interception point.
  intercept: (state, action) => {
    if (!approaching(state)) return 0;
    const dy = interceptY(state) - state.paddleX;
    if (Math.abs(dy) < 1.5) return action === 0 ? 1 : 0;
    return (dy > 0 ? 1 : -1) === action ? 1 : 0;
  },
  // Prefer stillness (energy saver, anti-jitter).
  holdStill: (_state, action) => (action === 0 ? 1 : 0),
  // Move away from the nearest wall when crowded.
  avoidWall: (state, action) => {
    const top = state.paddleX < PADDLE_H;
    const bottom = state.paddleX > COURT.h - PADDLE_H;
    if (top && action === 1) return 1;
    if (bottom && action === -1) return 1;
    return 0;
  },
  // Meet the ball off-center to bend the return angle.
  attackAngle: (state, action) => {
    if (!approaching(state) || Math.abs(state.ball.y - state.paddleX) > 6) return 0;
    const want = state.ball.y > COURT.h / 2 ? -1 : 1; // aim away from center mass
    return action === want ? 1 : 0;
  },
};
export const CONDITIONS = {
  always: () => true,
  defending: (state) => approaching(state),
  attacking: (state) => !approaching(state),
};

const LEVELS = [0, 0.25, 0.5, 1, 2];
const MAX_COMPONENTS = 4;

export function strategyVersion(components = [], parentId = null) {
  if (!Array.isArray(components) || components.length > MAX_COMPONENTS ||
      components.some((c) => !c || Object.keys(c).length !== 3 || !Object.hasOwn(FEATURES, c.feature) ||
        !Object.hasOwn(CONDITIONS, c.when) || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > 2) ||
      new Set(components.map((c) => c.feature)).size !== components.length) {
    throw new Error("Invalid strategy components");
  }
  const terms = components.map((c) => ({ feature: c.feature, weight: c.weight, when: c.when }))
    .sort((a, b) => a.feature.localeCompare(b.feature));
  const content = { parentId, implementationId, components: terms };
  return Object.freeze({ id: digest(content), ...content });
}

export const initialVersion = () => strategyVersion([], null);

export function checkVersion(v) {
  if (!v || typeof v.id !== "string" || v.implementationId !== implementationId ||
      strategyVersion(v.components ?? [], v.parentId ?? null).id !== v.id) {
    throw new Error("Strategy artifact changed or uses a different implementation");
  }
}

/** Reactive move: weighted votes, ties go to stay (the statue baseline). */
export function versionMove(version, state, rand) {
  checkVersion(version);
  void rand;
  let best = 0;
  let bestScore = -Infinity;
  for (const action of ACTIONS) {
    let s = 0;
    for (const c of version.components) {
      if (CONDITIONS[c.when](state)) s += c.weight * FEATURES[c.feature](state, action);
    }
    if (s > bestScore) {
      bestScore = s;
      best = action;
    }
  }
  return best;
}

/** Mirror sides so an X-policy can play O (Pong is left-right symmetric;
 *  the y axis is shared, so actions map as-is — no negation). */
export function mirrorState(state) {
  return {
    ball: { x: COURT.w - state.ball.x, y: state.ball.y, vx: -state.ball.vx, vy: state.ball.vy },
    paddleX: state.paddleO,
    paddleO: state.paddleX,
    scoreX: state.scoreO,
    scoreO: state.scoreX,
  };
}

/** Fixed predictive tracker: the v2 sparring partner. Stronger than the
 *  deadband (loses ~0.77 to the v1 champion, not 0-200) — headroom is real. */
export const PREDICTIVE = strategyVersion([
  { feature: "intercept", weight: 1, when: "always" },
  { feature: "retreatCenter", weight: 1, when: "always" },
  { feature: "trackBall", weight: 1, when: "always" },
], null);

/** Fixed deadband tracker (the v1 sparring partner). */
export function baselineMove(state) {
  const dy = state.ball.y - state.paddleO;
  const toward = state.ball.vx > 0;
  if (!toward || Math.abs(dy) < 1.5) return 0;
  return dy > 0 ? 1 : -1;
}

/** Sync deterministic proposer: single-component mutation, parentId-linked. */
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
  return strategyVersion(terms, champion.id);
}
