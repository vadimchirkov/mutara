import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { digest, version, validateVersion } from "teob-mutara";

export const implementation = Object.fromEntries(["lander.py", "planner.py", "experiment.mjs", "train.mjs"]
  .map((file) => [file, readFileSync(new URL(file, import.meta.url), "utf8")]));
const implementationId = digest(implementation);

// Constants of gymnasium's stock heuristic(); searched in [x/5, 5x].
export const INITIAL = Object.freeze({ kx: 0.5, kvx: 1, amax: 0.4, hx: 0.55, ka: 0.5, kw: 1, kh: 0.5, kvy: 0.5, gm: 20, ga: 20 });
// MPC (planner.py): the heuristic above is its warm start. Hand model gains come from `python planner.py`
// (windless env, fixed actions, least squares); cost weights are hand-set starting guesses.
// Model gains are never searched: `fitted: 0` pins them to HAND_MODEL, `fitted: 1` carries a least-squares
// fit from logged training flights (train.mjs). `wind_k` > 0 turns on the drift estimate over the last k steps.
export const HAND_MODEL = Object.freeze({ main_gain: 0.047, side_gain: 0.0066, torque_gain: 0.04, gravity: 0.0266 });
export const MPC_INITIAL = Object.freeze({ ...INITIAL, horizon: 20, samples: 64, noise: 0.3,
  w_pos: 1, w_vel: 1, w_angle: 1, w_spin: 0.3, w_fuel: 0.05, w_crash: 100, ...HAND_MODEL, fitted: 0, wind_k: 0 });
// Integer ranges, and the per-decision compute cap: samples × horizon model steps (~75 ms/episode at 64×20).
export const INTEGERS = Object.freeze({ horizon: [5, 40], samples: [16, 256], wind_k: [0, 50], fitted: [0, 1] });
export const MAX_ROLLOUT = 2048;
export const controllerOf = (config) => (Object.hasOwn(config, "horizon") ? "mpc" : "heuristic");
export const INITIALS = { heuristic: INITIAL, mpc: MPC_INITIAL };
export const bounds = (key, initial) => INTEGERS[key] ?? (key === "noise" ? [0.02, 1] : [initial[key] / 5, initial[key] * 5]);
export function validateConfig(config) {
  const initial = config && INITIALS[controllerOf(config)];
  if (!initial || Object.keys(config).sort().join() !== Object.keys(initial).sort().join() ||
      Object.keys(initial).some((k) => {
        const [lo, hi] = bounds(k, initial);
        return !Number.isFinite(config[k]) || config[k] < lo || config[k] > hi || (INTEGERS[k] && !Number.isInteger(config[k]));
      }) || (initial === MPC_INITIAL && (config.samples * config.horizon > MAX_ROLLOUT ||
        (!config.fitted && Object.entries(HAND_MODEL).some(([k, v]) => config[k] !== v))))) {
    throw new Error("Invalid lander controller");
  }
}
export const strategy = (config = INITIAL, parentId = null) => version(config, implementationId, parentId);
const checkVersion = (v) => { validateVersion(v, implementationId); validateConfig(v.config); };

// LUNAR_PYTHON=/path/to/python with gymnasium[box2d] skips uv.
const [command, ...prefix] = process.env.LUNAR_PYTHON ? [process.env.LUNAR_PYTHON] :
  ["uv", "run", "-q", "--python", "3.12", "--with", "gymnasium[box2d]==1.3.0", "--with", "numpy==2.5.3", "python"];
const script = new URL("lander.py", import.meta.url).pathname;
function simulate(input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...prefix, script], { maxBuffer: 1 << 24 }, (error, stdout, stderr) =>
      error ? reject(new Error(`lander.py failed: ${stderr || error.message}`)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

// Episode return >= 200 is Gymnasium's "solved"; a crash costs -100, so a negative return is a failure.
export function summarize(rows) {
  const n = rows.length;
  return { n, score: rows.reduce((s, r) => s + r.score, 0) / n,
    solved: rows.filter((r) => r.score >= 200).length / n, failed: rows.filter((r) => r.score < 0).length,
    seconds: rows.reduce((s, r) => s + r.seconds, 0) / n };
}
export const addFits = (fits) => fits.reduce((a, f) => ({ n: a.n + f.n,
  xtx: a.xtx.map((row, i) => row.map((v, j) => v + f.xtx[i][j])), xty: a.xty.map((v, i) => v + f.xty[i]) }));
const mean = (a, b) => (a.score * a.n + b.score * b.n) / (a.n + b.n);
// "both" is the Mutara gate. The others are ungated baselines for comparison:
// "pooled" sees the same episodes as one pool (same data, same cost); "training" sees the training half only.
export const GATES = {
  both: ({ training, validation }) => [training, validation].every(({ baseline, candidate }) =>
    candidate.score > baseline.score && candidate.failed <= baseline.failed),
  pooled: ({ training: t, validation: v }) => mean(t.candidate, v.candidate) > mean(t.baseline, v.baseline),
  training: ({ training }) => training.candidate.score > training.baseline.score,
};
export const adapter = {
  implementation, recovery: "repeatable",
  validateVersion: checkVersion,
  validatePlan(p) {
    checkVersion(p.initial);
    validateConfig(p.candidate);
    if (controllerOf(p.candidate) !== controllerOf(p.initial.config)) throw new Error("Controller changed mid-campaign");
    if (p.rounds !== 1 || !["selection", "audit"].includes(p.phase) || !Number.isFinite(p.wind) || p.wind < 0 || p.wind > 20 ||
        !Object.hasOwn(GATES, p.gate)) {
      throw new Error("Invalid landing protocol");
    }
    const keys = Object.keys(p.cases).sort().join();
    if (keys !== (p.phase === "selection" ? "training,validation" : "test")) throw new Error("Invalid case splits");
    const seeds = Object.values(p.cases).flat();
    if (Object.values(p.cases).some((s) => !Array.isArray(s) || !s.length) || new Set(seeds).size !== seeds.length ||
        seeds.some((s) => !Number.isSafeInteger(s) || s < 0 || s > 0xffffffff)) throw new Error("Invalid or overlapping seeds");
  },
  // Cost = simulated episodes, so the budget bounds compute, not dollars.
  limits: (p) => ({ executions: Object.keys(p.cases).length * 2, cost: 2 * Object.values(p.cases).flat().length }),
  propose: (champion, _history, p) => strategy(p.candidate, champion.id),
  jobs: (champion, candidate, p) => Object.entries(p.cases).flatMap(([split, seeds]) =>
    [["baseline", champion], ["candidate", candidate]].map(([side, v]) => ({
      key: `${split}:${side}`, input: { config: v.config, seeds, wind: p.wind, controller: controllerOf(v.config) }, costLimit: seeds.length,
    }))),
  async execute(job) {
    return { output: await simulate(job.input), cost: job.input.seeds.length };
  },
  grade(job, receipt) {
    const { runtime, rows, fit = null } = receipt.output ?? {};
    if (typeof runtime !== "object" || !Array.isArray(rows) || rows.length !== job.input.seeds.length ||
        rows.some((r, i) => r.seed !== job.input.seeds[i] || !Number.isFinite(r.score) || !Number.isFinite(r.seconds))) {
      throw new Error("Invalid landing observations");
    }
    if (fit && !(Number.isSafeInteger(fit.n) && fit.xtx?.length === 4 && fit.xty?.length === 4 &&
        [...fit.xtx.flat(), ...fit.xty].every(Number.isFinite))) throw new Error("Invalid fit statistics");
    return { metrics: { score: summarize(rows).score }, data: { runtime, rows, fit } };
  },
  assess(runs, p) {
    const runtimes = new Set(runs.map((r) => JSON.stringify(r.observation.data.runtime)));
    if (runtimes.size !== 1) throw new Error(`Runs came from different simulators: ${[...runtimes].join(" vs ")}`);
    const evaluation = Object.fromEntries(Object.keys(p.cases).map((split) => {
      const data = (side) => runs.find((r) => r.job.key === `${split}:${side}`).observation.data.rows;
      return [split, { baseline: summarize(data("baseline")), candidate: summarize(data("candidate")) }];
    }));
    // Model-fit statistics from training flights only (both sides); validation never feeds the fit.
    const fits = runs.filter((r) => r.job.key.startsWith("training:") && r.observation.data.fit).map((r) => r.observation.data.fit);
    if (fits.length) evaluation.fit = addFits(fits);
    const accepted = p.phase === "selection" && GATES[p.gate](evaluation);
    const reason = p.phase === "audit" ? "Final test only; never promotes" : `${p.gate}: ${accepted ? "gain" : "no gain"}`;
    return { evaluation: { runtime: runs[0].observation.data.runtime, ...evaluation }, decision: { accepted, reason } };
  },
};
