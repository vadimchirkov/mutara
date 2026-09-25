import { readFileSync } from "node:fs";
import { coreId, exceedsCost, type Adapter, type RunRecord } from "./engine.js";
import { canonical, version, digest, validateVersion, type Version } from "./version.js";
import { learnerHarness } from "./sqlite.js";
import { randomPropose, initialConfig, validateSpace, type Space } from "./search.js";
import { compositeDecision, validateMetrics, validateScores, type Metric, type DecisionRule } from "./multi-metric.js";

export type { Space, Dimension, FloatDim, IntDim, EnumDim } from "./search.js";
export type { Metric, DecisionRule } from "./multi-metric.js";

type Config = Record<string, unknown>;
type V = Version<Config>;
type Scores = Record<string, number>;
export interface ExecutionContext {
  id: string;
  /** Same case index for baseline and candidate; fresh indices in each round. */
  sample: number;
  costLimit: number;
}
export interface OptimizerOptions {
  space: Space;
  metrics: Metric[];
  /** JSON artifacts identifying executor, data, evaluator and their dependencies. */
  implementation: unknown;
  execute: (config: Config, context: ExecutionContext) => Promise<{ output: Scores; cost: number }>;
  recovery?: "repeatable" | "idempotent" | "manual";
  decision?: DecisionRule;
  samplesPerTrial?: number;
  budget?: { trials: number; cost?: number };
  costLimit?: number;
  seed?: number;
}
export interface OptimizeOptions extends OptimizerOptions {
  /** Reuse only to reopen this same experiment. Unique across shared executors. */
  id: string;
  storage?: string;
}
export interface OptimizerResult {
  id: string;
  champion: Config;
  history: { config: Config; metrics: Scores; accepted: boolean; reason: string }[];
  totalTrials: number;
  executions: number;
  spent: number;
}

interface Plan {
  initial: V;
  rounds: number;
  seed: number;
  space: Space;
  metrics: Metric[];
  samplesPerTrial: number;
  cost: number;
  costLimit: number;
  decision: DecisionRule;
}
interface Evaluation { baseline: Scores[]; candidate: Scores[] }

const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const optimizerImplementation = Object.fromEntries(["optimizer", "search", "multi-metric"].map((name) =>
  [name + extension, readFileSync(new URL(name + extension, import.meta.url), "utf8")]));

const paired = (runs: RunRecord[]) => ({
  baseline: runs.filter((r) => r.job.key.startsWith("baseline:")).map((r) => r.observation!.metrics),
  candidate: runs.filter((r) => r.job.key.startsWith("candidate:")).map((r) => r.observation!.metrics),
});

/** Use the same adapter in a host TEOB runtime, or with learnerHarness for reconciliation. */
export function createOptimizer(opts: OptimizerOptions) {
  if (typeof opts.execute !== "function") throw new Error("An executor is required");
  const settings = {
    space: opts.space, metrics: opts.metrics, samplesPerTrial: opts.samplesPerTrial ?? 1,
    rounds: opts.budget?.trials ?? 50, cost: opts.budget?.cost ?? 0, costLimit: opts.costLimit ?? 0,
    seed: opts.seed ?? 7919, decision: opts.decision ?? { mode: "bounded" as const },
  };
  canonical(settings);
  validateSpace(settings.space);
  validateMetrics(settings.metrics);
  if (!Number.isSafeInteger(settings.rounds) || settings.rounds < 1 || settings.rounds > 100) throw new Error("Trial budget must be between 1 and 100");
  if (!Number.isSafeInteger(settings.samplesPerTrial) || settings.samplesPerTrial < 1 ||
      !Number.isSafeInteger(settings.rounds * 2 * settings.samplesPerTrial)) throw new Error("Invalid samplesPerTrial");
  if (!Number.isSafeInteger(settings.seed)) throw new Error("Invalid seed");
  if (settings.cost < 0 || settings.costLimit < 0 || !Number.isFinite(settings.cost) || !Number.isFinite(settings.costLimit)) throw new Error("Invalid cost budget");
  if (exceedsCost(2 * settings.samplesPerTrial * settings.costLimit, settings.cost)) throw new Error("Budget cannot reserve one trial");
  // Validate the declared decision contract before making any external calls.
  const zero = Object.fromEntries(settings.metrics.map((m) => [m.name, m.bounds?.min ?? 0]));
  compositeDecision([zero], [zero], settings.metrics, { ...settings.decision, comparisons: settings.rounds });
  const recovery = opts.recovery ?? "manual";
  if (!["repeatable", "idempotent", "manual"].includes(recovery)) throw new Error("Invalid recovery mode");
  const implementation = structuredClone({ optimizer: optimizerImplementation, executor: opts.implementation, settings });
  const implId = digest(implementation);
  const plan: Plan = structuredClone({ ...settings, initial: version(initialConfig(settings.space), implId) });
  const planId = digest(plan);
  const execute = opts.execute;

  const adapter: Adapter<V, Plan, Evaluation> = {
    implementation, recovery,
    validatePlan(p) { if (digest(p) !== planId) throw new Error("Optimizer plan changed; use a new experiment ID"); },
    validateVersion(v) { validateVersion(v, implId); },
    limits: (p) => ({ executions: p.rounds * 2 * p.samplesPerTrial, cost: p.cost }),
    propose: (champion, history, p) => randomPropose(p.space, implId, champion, history.length, p.seed),
    jobs(champion, candidate, p, round) {
      return Array.from({ length: p.samplesPerTrial }, (_, i) => [
        { key: `baseline:${i}`, input: { config: champion.config, sample: round * p.samplesPerTrial + i }, costLimit: p.costLimit },
        { key: `candidate:${i}`, input: { config: candidate.config, sample: round * p.samplesPerTrial + i }, costLimit: p.costLimit },
      ]).flat();
    },
    async execute(job) {
      const { config, sample } = job.input as { config: Config; sample: number };
      return execute(config, { id: job.id, sample, costLimit: job.costLimit });
    },
    grade(_job, receipt, p) {
      const metrics = receipt.output as Scores;
      validateScores(metrics, p.metrics);
      return { metrics, data: null };
    },
    assess(runs, p) {
      const { baseline, candidate } = paired(runs);
      const { accepted, reason } = compositeDecision(baseline, candidate, p.metrics, { ...p.decision, comparisons: p.rounds });
      return { evaluation: { baseline, candidate }, decision: { accepted, reason } };
    },
    early(runs, p) {
      const { baseline, candidate } = paired(runs);
      return p.decision.mode === "sequential" && baseline.length === candidate.length &&
        compositeDecision(baseline, candidate, p.metrics, { ...p.decision, comparisons: p.rounds }).final === true;
    },
  };
  return { adapter, plan };
}

/** Run or reopen one bounded experiment; all progress belongs to the TEOB aggregate. */
export async function optimize(opts: OptimizeOptions): Promise<OptimizerResult> {
  if (typeof opts.id !== "string" || !opts.id.trim()) throw new Error("An experiment ID is required");
  const { adapter, plan } = createOptimizer(opts);
  const h = learnerHarness(opts.storage ?? ":memory:", adapter);
  try {
    const saved = await h.startOrResume(opts.id, plan);
    if (saved.coreId !== coreId || saved.adapterId !== digest({ implementation: adapter.implementation, recovery: adapter.recovery }) ||
        canonical(saved.plan) !== canonical(plan)) throw new Error("Recorded optimizer implementation or plan changed; use a new experiment ID");
    const state = await h.wait(opts.id);
    const history = state.trials.map((trial) => ({
      config: trial.candidate.config,
      metrics: Object.fromEntries(plan.metrics.map((m) => [m.name,
        trial.evaluation.candidate.reduce((sum, s) => sum + s[m.name] / trial.evaluation.candidate.length, 0)])),
      accepted: trial.accepted, reason: trial.reason,
    }));
    return { id: opts.id, champion: state.champion!.config, history, totalTrials: state.trials.length,
      executions: state.executions, spent: state.spent };
  } finally { await h.close(); }
}
