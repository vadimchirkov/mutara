// CFR-as-adapter: the engine drives iterations; regrets and the average
// strategy live inside the version (finite JSON, digest-pinned). One engine
// round = one exact CFR iteration over all 6 deals. No sampling, no noise.
// propose = regret matching, execute = exact tree walks, assess = update +
// always accept (CFR converges in the average, not by selection).
import { readFileSync } from "node:fs";
import { digest } from "mutara";

export const implementation = {
  game: "kuhn-cfr-v1",
  rules: "vanilla CFR, one round = one iteration, exact tree walks, regrets+avg inside version, always accept",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "cfr.mjs": readFileSync(new URL("./cfr.mjs", import.meta.url), "utf8"),
  },
};
export const implementationId = digest(implementation);

/** Regret matching: 12 infosets × [passive, aggressive]. */
export function regretMatching(regret24) {
  return Array.from({ length: 12 }, (_, i) => {
    const pos = [Math.max(regret24[2 * i], 0), Math.max(regret24[2 * i + 1], 0)];
    const sum = pos[0] + pos[1];
    return sum > 0 ? [pos[0] / sum, pos[1] / sum] : [0.5, 0.5];
  });
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function cfrVersion({ policy, regret, avg, iter }, parentId = null) {
  if (!Array.isArray(policy) || policy.length !== 12 || policy.some((p) => !finite(p) || p < 0 || p > 1) ||
      !Array.isArray(regret) || regret.length !== 24 || regret.some((r) => !finite(r)) ||
      !Array.isArray(avg) || avg.length !== 24 || avg.some((a) => !finite(a) || a < 0) ||
      !Number.isSafeInteger(iter) || iter < 0) {
    throw new Error("Invalid CFR version");
  }
  const content = { parentId, implementationId, policy: policy.slice(), regret: regret.slice(), avg: avg.slice(), iter };
  return Object.freeze({ id: digest(content), ...content });
}

export const initialVersion = () => cfrVersion({
  policy: Array(12).fill(0.5), regret: Array(24).fill(0), avg: Array(24).fill(0), iter: 0,
}, null);

export function checkVersion(v) {
  if (!v || typeof v.id !== "string" || v.implementationId !== implementationId ||
      cfrVersion({ policy: v.policy, regret: v.regret, avg: v.avg, iter: v.iter }, v.parentId ?? null).id !== v.id) {
    throw new Error("CFR artifact changed or uses a different implementation");
  }
}

/** Average strategy = the Nash approximation. Uniform where never reached. */
export function finalPolicy(version) {
  checkVersion(version);
  return Array.from({ length: 12 }, (_, i) => {
    const sum = version.avg[2 * i] + version.avg[2 * i + 1];
    return sum > 0 ? version.avg[2 * i + 1] / sum : 0.5;
  });
}

// Exact CFR iteration over all 6 deals. Textbook Neller–Lanctot form: the
// profile is read at infoset-visit time, so later infosets see earlier
// updates from the same sweep. (A frozen-profile variant was tried first and
// stalls at honest-level exploitability; documented, not theorized.)
// Chance (1/6) folded into every accumulation. Mutates regret/avg in place.
function cfrIter(regret, avg) {
  const strat = (i) => {
    const pos = [Math.max(regret[i][0], 0), Math.max(regret[i][1], 0)];
    const sum = pos[0] + pos[1];
    return sum > 0 ? [pos[0] / sum, pos[1] / sum] : [0.5, 0.5];
  };
  const K = 1 / 6;
  // Record values in the acting player's perspective; return P1 EV upward.
  // The same visit never updates its own infoset twice, so the snapshot s
  // and the recording agree.
  const acc = (i, v0, v1, ro, rn) => {
    const s = strat(i);
    const blend = s[0] * v0 + s[1] * v1;
    regret[i][0] += K * ro * (v0 - blend);
    regret[i][1] += K * ro * (v1 - blend);
    avg[i][0] += K * rn * s[0];
    avg[i][1] += K * rn * s[1];
  };
  const face2 = (c1, c2, r1, r2) => { // P2 facing bet
    const i = 9 + c2, s = strat(i), vF = 1, vC = c1 > c2 ? 2 : -2;
    acc(i, -vF, -vC, r1, r2);
    return s[0] * vF + s[1] * vC;
  };
  const face1 = (c1, c2, r1, r2) => { // P1 facing bet
    const i = 6 + c1, s = strat(i), vF = -1, vC = c1 > c2 ? 2 : -2;
    acc(i, vF, vC, r2, r1);
    return s[0] * vF + s[1] * vC;
  };
  const afterCheck = (c1, c2, r1, r2) => { // P2 after check
    const i = 3 + c2, s = strat(i), vC = c1 > c2 ? 1 : -1, vB = face1(c1, c2, r1, r2 * s[1]);
    acc(i, -vC, -vB, r1, r2);
    return s[0] * vC + s[1] * vB;
  };
  const open = (c1, c2, r1, r2) => { // P1 open
    const s = strat(c1);
    const vC = afterCheck(c1, c2, r1 * s[0], r2), vB = face2(c1, c2, r1 * s[1], r2);
    acc(c1, vC, vB, r2, r1);
    return s[0] * vC + s[1] * vB;
  };
  for (const c1 of [0, 1, 2]) for (const c2 of [0, 1, 2]) {
    if (c1 !== c2) open(c1, c2, 1, 1);
  }
}

function validatePlan(p) {
  if (!Number.isSafeInteger(p.seed) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 2000) {
    throw new Error("Invalid CFR plan");
  }
  checkVersion(p.initial);
}

export const adapter = {
  implementation: {
    ...implementation,
    adapter: readFileSync(new URL("./cfr.mjs", import.meta.url), "utf8"),
  },
  recovery: "repeatable",
  validatePlan,
  validateVersion: (v) => checkVersion(v),
  limits: (p) => ({ executions: p.rounds, cost: 0 }),
  // The whole iteration lives here: sync, deterministic, pure local compute.
  // The engine contributes journaling, lineage (parentId), budgets, recovery.
  propose: (champion) => {
    const regret = Array.from({ length: 12 }, (_, i) => [champion.regret[2 * i], champion.regret[2 * i + 1]]);
    const avg = Array.from({ length: 12 }, (_, i) => [champion.avg[2 * i], champion.avg[2 * i + 1]]);
    cfrIter(regret, avg);
    const flat = (nested) => nested.flat();
    return cfrVersion({
      policy: regretMatching(flat(regret)).map(([, a]) => a),
      regret: flat(regret), avg: flat(avg), iter: champion.iter + 1,
    }, champion.id);
  },
  jobs: (champion, candidate) => [{ key: "cfr-iter", input: { version: candidate }, costLimit: 0 }],
  async execute(job) {
    const { version } = job.input;
    checkVersion(version);
    return { output: { iter: version.iter }, cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess(runs) {
    const { iter } = runs[0].observation.data;
    return { evaluation: { iter }, decision: { accepted: true, reason: `cfr iteration ${iter}` } };
  },
};

export function buildCfrPlan({ rounds = 300, seed = 7919 } = {}) {
  return { rounds, seed, initial: initialVersion() };
}
