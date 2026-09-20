// Copy into the host project and replace this small classifier with its real task.
import { readFileSync } from "node:fs";
import { digest, version, validateVersion } from "mutara";

/** @typedef {{ threshold: number, cases: [number, boolean][] }} Input */
/** @type {[number, boolean][]} */
const training = [[0.1, false], [0.3, false], [0.4, false], [0.6, true], [0.8, true], [0.95, true]];
/** @type {[number, boolean][]} */
const validation = [[0.15, false], [0.35, false], [0.55, true], [0.75, true]];
// Record code and data, not only a label such as "v1". Include model/prompt versions
// and every behavior-changing dependency when adapting this to a real task.
const implementation = { source: readFileSync(new URL(import.meta.url), "utf8"), training, validation };
const implementationId = digest(implementation);
export const initial = version({ threshold: 0.9 }, implementationId);
export const plan = { initial, rounds: 3 };

/** @type {import('mutara').Adapter<typeof initial, typeof plan, { trainingGain: number, validationGain: number }>} */
export const adapter = {
  implementation,
  recovery: "repeatable", // Local, free, deterministic computation only.
  validatePlan(p) {
    if (p.rounds > 3) throw new Error("This example has three candidates");
  },
  validateVersion(v) {
    validateVersion(v, implementationId);
    if (!Number.isFinite(v.config.threshold) || v.config.threshold < 0 || v.config.threshold > 1) {
      throw new Error("threshold must be between 0 and 1");
    }
  },
  limits: (p) => ({ executions: p.rounds * 4, cost: 0 }),
  propose: (champion, history) => version({ threshold: [0.7, 0.5, 0.3][history.length] }, implementationId, champion.id),
  jobs: (champion, candidate) => [
    { key: "baselineTraining", input: { threshold: champion.config.threshold, cases: training }, costLimit: 0 },
    { key: "candidateTraining", input: { threshold: candidate.config.threshold, cases: training }, costLimit: 0 },
    { key: "baselineValidation", input: { threshold: champion.config.threshold, cases: validation }, costLimit: 0 },
    { key: "candidateValidation", input: { threshold: candidate.config.threshold, cases: validation }, costLimit: 0 },
  ],
  async execute(job) {
    const { threshold, cases } = /** @type {Input} */ (job.input);
    return { output: cases.map(([confidence]) => confidence >= threshold), cost: 0 };
  },
  grade(job, receipt) {
    const labels = /** @type {Input} */ (job.input).cases.map(([, expected]) => expected);
    const output = receipt.output;
    if (!Array.isArray(output) || output.length !== labels.length ||
        output.some((v) => typeof v !== "boolean")) throw new Error("Invalid predictions");
    const accuracy = labels.filter((expected, i) => output[i] === expected).length / labels.length;
    return { metrics: { accuracy }, data: null };
  },
  assess(runs) {
    const scores = Object.fromEntries(runs.map((r) => {
      if (!r.observation) throw new Error("Missing grade");
      return [r.job.key, r.observation.metrics.accuracy];
    }));
    const evaluation = {
      trainingGain: scores.candidateTraining - scores.baselineTraining,
      validationGain: scores.candidateValidation - scores.baselineValidation,
    };
    return { evaluation, decision: {
      accepted: evaluation.trainingGain > 0 && evaluation.validationGain > 0,
      reason: JSON.stringify(evaluation),
    } };
  },
};
