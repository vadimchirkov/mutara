// Alchemy compatibility adapter. The lifecycle lives in self-learning/engine.ts.
import { createLearner, type Adapter, type State, type Event, type Trial } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { implementation, proposers, weightedPolicy, restoreMemory,
  type StrategyVersion, type MemorySnapshot, type SearchMethod, type Proposer } from "./strategy.js";

export interface EpisodeResult { seed: number; score: number; attempts: number; traceHash: string }
export interface Evaluation {
  baselineTraining: EpisodeResult[];
  candidateTraining: EpisodeResult[];
  baselineValidation: EpisodeResult[];
  candidateValidation: EpisodeResult[];
}
export interface ExperimentPlan {
  method: SearchMethod;
  seed: number;
  rounds: number;
  attempts: number;
  trainingSeeds: number[];
  validationSeeds: number[];
  minimumGain: number;
  tableHash: string;
  memory: MemorySnapshot;
  initial: StrategyVersion;
}

export type ExperimentState = State<StrategyVersion, ExperimentPlan, Evaluation>;
export type ExperimentEvent = Event<StrategyVersion, ExperimentPlan, Evaluation>;
export type ExperimentTrial = Trial<StrategyVersion, Evaluation>;
export type Evaluator = (version: StrategyVersion, seeds: number[], plan: ExperimentPlan) => Promise<EpisodeResult[]>;
export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function validSeeds(seeds: number[]) {
  return Array.isArray(seeds) && seeds.length > 0 && new Set(seeds).size === seeds.length && seeds.every(Number.isSafeInteger);
}
function validatePlan(p: ExperimentPlan) {
  if (!Object.hasOwn(proposers, p.method) || !Number.isSafeInteger(p.seed) ||
      !Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100 ||
      !Number.isSafeInteger(p.attempts) || p.attempts < 1 ||
      !Number.isFinite(p.minimumGain) || p.minimumGain <= 0 || !p.tableHash ||
      !validSeeds(p.trainingSeeds) || !validSeeds(p.validationSeeds) ||
      p.trainingSeeds.some((s) => p.validationSeeds.includes(s))) throw new Error("Invalid experiment plan or overlapping seed sets");
  weightedPolicy(p.initial);
  restoreMemory(p.memory);
}

export function decideCandidate(e: Evaluation, plan: ExperimentPlan): { accepted: boolean; reason: string } {
  for (const [episodes, seeds] of [
    [e.baselineTraining, plan.trainingSeeds], [e.candidateTraining, plan.trainingSeeds],
    [e.baselineValidation, plan.validationSeeds], [e.candidateValidation, plan.validationSeeds],
  ] as const) {
    if (!Array.isArray(episodes) || episodes.length !== seeds.length || episodes.some((r, i) =>
      r.seed !== seeds[i] || !Number.isSafeInteger(r.score) || r.score < 4 ||
      !Number.isSafeInteger(r.attempts) || r.attempts < 0 || r.attempts > plan.attempts ||
      typeof r.traceHash !== "string" || !r.traceHash.startsWith("sha256:"))) throw new Error("Invalid or unpaired evaluation");
  }
  const train = mean(e.candidateTraining.map((r, i) => r.score - e.baselineTraining[i].score));
  const deltas = e.candidateValidation.map((r, i) => r.score - e.baselineValidation[i].score);
  const validation = mean(deltas);
  const wins = deltas.filter((n) => n > 0).length;
  const accepted = train >= plan.minimumGain && validation >= plan.minimumGain && wins > deltas.length / 2;
  return { accepted, reason: `train delta=${train.toFixed(3)}, validation delta=${validation.toFixed(3)}, wins=${wins}/${deltas.length}` };
}


export function alchemyAdapter(evaluate: Evaluator, propose?: Proposer): Adapter<StrategyVersion, ExperimentPlan, Evaluation> {
  return {
    implementation,
    validatePlan,
    validateVersion: (v) => { weightedPolicy(v); },
    limits: (p) => ({ executions: p.rounds * 4, cost: 0 }),
    recovery: "repeatable",
    propose: (champion, history, p) => (propose ?? proposers[p.method])(champion, history.length, p.seed),
    jobs: (champion, candidate, p) => [
      { key: "baselineTraining", input: { version: champion, seeds: p.trainingSeeds }, costLimit: 0 },
      { key: "candidateTraining", input: { version: candidate, seeds: p.trainingSeeds }, costLimit: 0 },
      { key: "baselineValidation", input: { version: champion, seeds: p.validationSeeds }, costLimit: 0 },
      { key: "candidateValidation", input: { version: candidate, seeds: p.validationSeeds }, costLimit: 0 },
    ],
    async execute(job, plan) {
      const { version, seeds } = job.input as { version: StrategyVersion; seeds: number[] };
      return { output: await evaluate(version, seeds, plan), cost: 0 };
    },
    grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
    assess(runs, plan) {
      const evaluation = Object.fromEntries(runs.map((r) => [r.job.key, r.observation!.data])) as unknown as Evaluation;
      return { evaluation, decision: decideCandidate(evaluation, plan) };
    },
  };
}

export const createExperimentAggregate = (evaluate: Evaluator, propose?: Proposer) =>
  createLearner(alchemyAdapter(evaluate, propose)).aggregate;
export const experimentHarness = (path: string, evaluate: Evaluator, propose?: Proposer) =>
  learnerHarness(path, alchemyAdapter(evaluate, propose));
