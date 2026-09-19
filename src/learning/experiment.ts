import { CategoryId, EntityId, categoryTypes, persist, andRun, run, done, reply, objectCodec, tagCodec,
  type Aggregate, type EffectControl } from "@lambda-house/teob-ts/core";
import { registration } from "@lambda-house/teob-ts/inmem";
import { createSqliteRuntime } from "@lambda-house/teob-ts/sqlite";
import { implementation, implementationId, proposers, weightedPolicy, restoreMemory,
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
export interface Trial {
  round: number;
  candidate: StrategyVersion;
  baselineId: string;
  evaluation: Evaluation;
  accepted: boolean;
  reason: string;
}
export interface ExperimentState {
  status: "idle" | "running" | "finished" | "failed";
  plan?: ExperimentPlan;
  champion?: StrategyVersion;
  pending?: { round: number; candidate: StrategyVersion };
  trials: Trial[];
  error?: string;
}
export type ExperimentCommand =
  | { tag: "start"; plan: ExperimentPlan }
  | { tag: "advance"; resume?: boolean }
  | { tag: "evaluated"; round: number; candidateId: string; evaluation: Evaluation }
  | { tag: "failed"; round: number; message: string }
  | { tag: "get_state" };
export type ExperimentEvent =
  | { tag: "experiment_started"; plan: ExperimentPlan; implementation: typeof implementation }
  | { tag: "candidate_proposed"; round: number; candidate: StrategyVersion }
  | { tag: "candidate_decided"; trial: Trial }
  | { tag: "experiment_finished" }
  | { tag: "experiment_failed"; message: string };
type Reply = { tag: "state"; state: ExperimentState } | { tag: "error"; message: string };
export type Evaluator = (version: StrategyVersion, seeds: number[], plan: ExperimentPlan) => Promise<EpisodeResult[]>;
export const experimentCategory = categoryTypes<ExperimentCommand, Reply>(CategoryId("learning"));
const eventCodec = tagCodec<ExperimentEvent>("experiment_started", "candidate_proposed", "candidate_decided", "experiment_finished", "experiment_failed");
const stateCodec = objectCodec<ExperimentState>("LearningExperiment");
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

export function createExperimentAggregate(evaluate: Evaluator, propose?: Proposer): Aggregate<ExperimentCommand, Reply, ExperimentEvent, ExperimentState> {
  async function execute(s: ExperimentState, candidate: StrategyVersion, ctx: EffectControl<ExperimentCommand, Reply>) {
    const p = s.plan!;
    let evaluation: Evaluation;
    try {
      // Both candidates receive independent copies of one frozen prior. Evaluation
      // outcomes never feed back into that memory or reveal the hidden recipe table.
      const play = (v: StrategyVersion, seeds: number[]) => evaluate(structuredClone(v), [...seeds], structuredClone(p));
      evaluation = {
        baselineTraining: await play(s.champion!, p.trainingSeeds),
        candidateTraining: await play(candidate, p.trainingSeeds),
        baselineValidation: await play(s.champion!, p.validationSeeds),
        candidateValidation: await play(candidate, p.validationSeeds),
      };
      decideCandidate(evaluation, p);
    } catch (error) {
      await ctx.tellSelf({ tag: "failed", round: s.trials.length,
        message: error instanceof Error ? error.message : "Evaluation failed" });
      return;
    }
    await ctx.tellSelf({ tag: "evaluated", round: s.trials.length, candidateId: candidate.id, evaluation });
  }
  return {
    category: experimentCategory.categoryId,
    initial: () => ({ status: "idle", trials: [] }),
    async decide(s, command, ctx) {
      switch (command.tag) {
        case "start": {
          if (s.status !== "idle") return reply({ tag: "error", message: "Experiment already started" });
          try { validatePlan(command.plan); } catch (e) {
            return reply({ tag: "error", message: (e as Error).message });
          }
          await ctx.tellSelf({ tag: "advance" });
          return persist({ tag: "experiment_started", plan: structuredClone(command.plan), implementation });
        }
        case "advance": {
          if (s.status !== "running" || (s.pending && !command.resume)) return done();
          if (s.plan!.initial.implementationId !== implementationId) {
            return persist({ tag: "experiment_failed", message: "Restore the recorded implementation before resuming" });
          }
          if (s.trials.length >= s.plan!.rounds) return persist({ tag: "experiment_finished" });
          let candidate: StrategyVersion;
          try {
            candidate = s.pending?.candidate ?? (propose ?? proposers[s.plan!.method])(
              structuredClone(s.champion!), s.trials.length, s.plan!.seed);
            weightedPolicy(candidate);
            if (candidate.parentId !== s.champion!.id) throw new Error("Candidate must identify its parent");
          } catch (error) {
            return persist({ tag: "experiment_failed", message: (error as Error).message });
          }
          const effect = () => execute(s, candidate, ctx);
          return s.pending ? run(effect) : andRun(persist({ tag: "candidate_proposed", round: s.trials.length, candidate }), effect);
        }
        case "evaluated": {
          if (s.status !== "running" || s.pending?.round !== command.round || s.pending.candidate.id !== command.candidateId) return done();
          let decision: ReturnType<typeof decideCandidate>;
          try { decision = decideCandidate(command.evaluation, s.plan!); } catch (error) {
            return persist({ tag: "experiment_failed", message: (error as Error).message });
          }
          await ctx.tellSelf({ tag: "advance" });
          return persist({ tag: "candidate_decided", trial: { round: command.round,
            candidate: s.pending.candidate, baselineId: s.champion!.id,
            evaluation: command.evaluation, ...decision } });
        }
        case "failed":
          if (s.status !== "running" || s.pending?.round !== command.round) return done();
          return persist({ tag: "experiment_failed", message: command.message });
        case "get_state": return reply({ tag: "state", state: structuredClone(s) });
      }
    },
    apply(s, e) {
      switch (e.tag) {
        case "experiment_started": return { status: "running", plan: e.plan, champion: e.plan.initial, trials: [] };
        case "candidate_proposed": return { ...s, pending: { round: e.round, candidate: e.candidate } };
        case "candidate_decided": {
          const { pending: _, ...rest } = s;
          return { ...rest, champion: e.trial.accepted ? e.trial.candidate : s.champion, trials: [...s.trials, e.trial] };
        }
        case "experiment_finished": return { ...s, status: "finished" };
        case "experiment_failed": return { ...s, status: "failed", error: e.message };
      }
    },
    async onRecoveryComplete(s, ctx) {
      if (s.status === "running") await ctx.tellSelf({ tag: "advance", resume: true });
    },
  };
}

/** Small runtime for experiment entities; games remain in the environment adapter. */
export function experimentHarness(path: string, evaluate: Evaluator, propose?: Proposer) {
  const completed = new Set<string>();
  const waiters = new Map<string, () => void>();
  const { runtime } = createSqliteRuntime({ path, recoverEntitiesOnStart: true, askTimeoutMs: 30_000,
    onPersisted(batch) {
      if (batch.records.some((r) => r.manifest === "experiment_finished" || r.manifest === "experiment_failed")) {
        completed.add(batch.entityId);
        waiters.get(batch.entityId)?.();
      }
    },
  }, [registration(createExperimentAggregate(evaluate, propose), eventCodec, stateCodec)]);
  const ready = runtime.start();
  async function state(id: string) {
    await ready;
    const r = await runtime.ask(EntityId(id), { tag: "get_state" }, experimentCategory);
    if (!r.ok || r.value.reply?.tag !== "state") throw new Error(`Cannot read experiment ${id}`);
    return r.value.reply.state;
  }
  return {
    state,
    async start(id: string, plan: ExperimentPlan) {
      await ready;
      const r = await runtime.ask(EntityId(id), { tag: "start", plan }, experimentCategory);
      if (!r.ok) throw new Error(`Cannot start experiment ${id}`);
      if (r.value.reply?.tag === "error") throw new Error(r.value.reply.message);
    },
    async wait(id: string, timeoutMs = 300_000) {
      const current = await state(id);
      if (current.status === "failed") throw new Error(current.error);
      if (current.status === "finished") return current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!completed.has(id)) await new Promise<void>((resolve, reject) => {
          waiters.set(id, resolve);
          timer = setTimeout(() => reject(new Error(`Experiment ${id} timed out`)), timeoutMs);
        });
      } finally { clearTimeout(timer); waiters.delete(id); }
      const result = await state(id);
      if (result.status === "failed") throw new Error(result.error);
      return result;
    },
    close: () => runtime.shutdown(),
  };
}
