// Search space for Kuhn: a 12-number information-set policy on a 0.1 grid.
// Proposer nudges one dim ±0.1. Pure, finite JSON, same contract as siblings.
import { readFileSync } from "node:fs";
import { digest } from "mutara";
import { rng } from "./game.mjs";

export const implementation = {
  game: "kuhn-v1",
  rules: "ante 1, bet 1, version plays both seats, train vs HONEST, validate vs TRICKY, exact EV over 6 deals",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "strategy.mjs": readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

export const DIMS = 12;
const GRID = 10; // 0.0..1.0 step 0.1

// Straightforward start: value-bet/call Q,K, never bluff, always fold J.
// Learning = discovering bluffs and thin calls from here.
const HONEST_START = [0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1];

export const HONEST = HONEST_START.slice();
export const TRICKY = [0.3, 0, 1, 0.2, 0.7, 1, 0, 0.5, 1, 0.1, 0.6, 1];

export function policyVersion(policy, parentId = null) {
  if (!Array.isArray(policy) || policy.length !== DIMS ||
      policy.some((p) => typeof p !== "number" || p < 0 || p > 1 || Math.abs(p * GRID - Math.round(p * GRID)) > 1e-9)) {
    throw new Error("Policy must be 12 grid probabilities in [0, 1]");
  }
  const rounded = policy.map((p) => Math.round(p * GRID) / GRID);
  const content = { parentId, implementationId, policy: rounded };
  return Object.freeze({ id: digest(content), ...content });
}

export const initialVersion = () => policyVersion(HONEST_START, null);

export function checkVersion(v) {
  if (!v || typeof v.id !== "string" || v.implementationId !== implementationId ||
      policyVersion(v.policy, v.parentId ?? null).id !== v.id) {
    throw new Error("Strategy artifact changed or uses a different implementation");
  }
}

/** Deterministic mutation: one dim nudge, two when round % 4 == 3
 *  (same operator family as the tictactoe proposer). */
export function proposePolicy(champion, round, seed) {
  const random = rng((seed + round * 0x9e3779b9) | 0);
  const nudge = (policy, startDim, up, salt) => {
    for (let k = 0; k < DIMS; k++) {
      const dim = (startDim + k) % DIMS;
      const cur = Math.round(policy[dim] * GRID);
      const step = (((dim + round + salt) % 2 === 0) === up) ? 1 : -1;
      const next = cur + step;
      if (next < 0 || next > GRID) continue;
      const out = policy.slice();
      out[dim] = next / GRID;
      return out;
    }
    return null;
  };
  let policy = champion.policy.slice();
  const steps = round % 4 === 3 ? 2 : 1;
  for (let m = 0; m < steps; m++) {
    const next = nudge(policy, Math.floor(random() * DIMS), random() < 0.5, m);
    if (!next) break;
    policy = next;
  }
  if (policy.every((p, i) => p === champion.policy[i])) {
    policy = policy.slice();
    policy[0] = policy[0] >= 1 ? 0.9 : policy[0] + 0.1;
  }
  return policyVersion(policy, champion.id);
}
