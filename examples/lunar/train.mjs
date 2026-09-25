import { pathToFileURL } from "node:url";
import { coreId, digest } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, addFits, bounds, controllerOf, HAND_MODEL, INITIAL, INITIALS, INTEGERS, MAX_ROLLOUT, MPC_INITIAL, strategy,
  validateConfig } from "./experiment.mjs";

export const PROTOCOL = Object.freeze({ rounds: 30, samples: 30, finalCases: 200, sigma: 0.25 });

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// MPC variants: which learned-model switches Mutara may touch. Model gains are never searched.
export const VARIANTS = Object.freeze({
  hand: { start: { fitted: 0, wind_k: 0 }, frozen: ["fitted", "wind_k"] },
  fitted: { start: { fitted: 1, wind_k: 0 }, frozen: ["fitted", "wind_k"] },
  wind: { start: { fitted: 1, wind_k: 10 }, frozen: ["fitted"], min: { wind_k: 1 } },
  auto: { start: { fitted: 0, wind_k: 0 }, frozen: [] },
});
const initialFor = (controller) => controller === "heuristic" ? INITIAL : { ...MPC_INITIAL, ...VARIANTS[controller].start };

// Log-normal step on every continuous parameter, ±1 or ±25% (rounded) on integers, clamped to the
// searched box; `fitted` flips with probability 0.2. Deterministic per (seed, generation); heuristic keys
// draw exactly as before MPC existed. Model gains follow `fitted`: HAND_MODEL, or the latest fit if any.
export function propose(config, generation, seed, { frozen = [], min = {}, model = null } = {}) {
  const random = rng(seed * 7919 + generation);
  const initial = INITIALS[controllerOf(config)];
  const next = Object.fromEntries(Object.entries(config).map(([k, v]) => {
    const [lo, hi] = bounds(k, initial);
    const [u, w] = [random(), random()];
    if (frozen.includes(k) || Object.hasOwn(HAND_MODEL, k)) return [k, v];
    if (k === "fitted") return [k, u < 0.2 ? 1 - v : v];
    const stepped = INTEGERS[k] ? (u < 0.5 ? v + (w < 0.5 ? -1 : 1) : Math.round(v * (w < 0.5 ? 0.8 : 1.25))) :
      v * Math.exp(PROTOCOL.sigma * Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * w));
    return [k, Math.min(hi, Math.max(min[k] ?? lo, stepped))];
  }));
  if (Object.hasOwn(next, "fitted")) {
    const gains = next.fitted ? model ?? {} : HAND_MODEL;
    for (const [k, v] of Object.entries(gains)) next[k] = Math.min(bounds(k, initial)[1], Math.max(bounds(k, initial)[0], v));
  }
  // Compute cap: shrink samples first, the horizon is what the planner sees.
  if (next.samples * next.horizon > MAX_ROLLOUT) next.samples = Math.floor(MAX_ROLLOUT / next.horizon);
  return next;
}

// Least squares on accumulated normal equations: Gaussian elimination with partial pivoting; null if singular.
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; M[r] = M[r].map((v, j) => v - f * M[c][j]); }
  }
  return M.map((row, i) => row[n] / row[i]);
}
// Order matches planner.features: theta = (main_gain, side_gain, gravity, torque_gain).
export function fitModel(fit) {
  const theta = fit && fit.n >= 200 ? solve(fit.xtx, fit.xty) : null;
  return theta && { main_gain: theta[0], side_gain: theta[1], gravity: theta[2], torque_gain: theta[3] };
}

export async function train({ storage, id, seed = 7919, wind = 20, gate = "both", fixed = false, controller = "heuristic",
  auditWind = wind, onProgress = () => {} }) {
  if (!storage || typeof id !== "string" || !id.trim() || !Number.isSafeInteger(seed) || seed < 1 || seed > 40000) {
    throw new Error("Invalid campaign");
  }
  if (controller !== "heuristic" && !Object.hasOwn(VARIANTS, controller)) {
    throw new Error("Invalid controller");
  }
  const h = learnerHarness(storage, adapter);
  const history = [];
  const initial = initialFor(controller);
  const variant = VARIANTS[controller] ?? {};
  let champion = strategy(initial);
  let fit = null; // accumulated training-flight statistics, rebuilt from the journal on replay
  async function run(experimentId, plan) {
    adapter.validatePlan(plan);
    const saved = await h.startOrResume(experimentId, plan);
    if (digest(saved.plan) !== digest(plan) || saved.coreId !== coreId ||
        saved.adapterId !== digest({ implementation: adapter.implementation, recovery: adapter.recovery })) {
      throw new Error("Campaign artifact changed; restore it or use a new ID");
    }
    return h.wait(experimentId);
  }
  try {
    for (let generation = 0; generation < PROTOCOL.rounds; generation++) {
      const base = seed * 50000 + generation * 1000;
      const candidate = propose(champion.config, generation, seed, { ...variant, model: fitModel(fit) });
      validateConfig(candidate);
      const plan = { initial: champion, candidate, rounds: 1, phase: "selection", wind, gate,
        // fixed: one training benchmark for the whole campaign, as when tuning on "seeds 0..29"; validation stays fresh.
        cases: { training: Array.from({ length: PROTOCOL.samples }, (_, i) => (fixed ? seed * 50000 + 999000 : base) + i),
          validation: Array.from({ length: PROTOCOL.samples }, (_, i) => base + 500 + i) } };
      const state = await run(`${id}/trial-${generation}`, plan);
      champion = state.champion;
      const { accepted, evaluation } = state.trials[0];
      if (evaluation.fit) fit = fit ? addFits([fit, evaluation.fit]) : evaluation.fit;
      const { training, validation } = evaluation;
      history.push({ generation: generation + 1, accepted, entering: training.baseline.score,
        // An optimizer that trusts its own training seeds would have promoted this one.
        trainingOnly: !accepted && training.candidate.score > training.baseline.score,
        training: training.candidate.score - training.baseline.score,
        validation: validation.candidate.score - validation.baseline.score });
      await onProgress({ phase: "training", ...history.at(-1) });
    }
    // auditWind ≠ wind is the transfer test: selected at one wind level, audited at another.
    const plan = { initial: strategy(initial), candidate: champion.config, rounds: 1, phase: "audit", wind: auditWind, gate,
      cases: { test: Array.from({ length: PROTOCOL.finalCases }, (_, i) => 3000000000 + seed * 2000 + i) } };
    const { runtime, test: audit } = (await run(`${id}/final-test`, plan)).trials[0].evaluation;
    const report = { id, seed, wind, auditWind, gate, fixed, controller, model: fitModel(fit), phase: "finished", runtime, champion: champion.config,
      accepted: history.filter((r) => r.accepted).length,
      caughtByValidation: history.filter((r) => r.trainingOnly).length,
      audit: { stock: audit.baseline, champion: audit.candidate }, history };
    await onProgress(report);
    return report;
  } finally { await h.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [storage, id, seedText = "7919", windText = "20", gate = "both", seedsText = "fresh", controller = "heuristic",
    auditWindText = windText] = process.argv.slice(2);
  try {
    await train({ storage, id, seed: Number(seedText), wind: Number(windText), gate, fixed: seedsText === "fixed", controller,
      auditWind: Number(auditWindText), onProgress: (s) =>
      console.log(s.phase === "training" ?
        `gen ${s.generation}: ${s.accepted ? "ACCEPT" : s.trainingOnly ? "caught " : "reject "} ` +
        `Δtrain ${s.training.toFixed(1)} Δval ${s.validation.toFixed(1)}` : JSON.stringify({ ...s, history: undefined }, null, 1)) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
