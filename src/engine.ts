import { readFileSync } from "node:fs";
import { CategoryId, categoryTypes, persist, andRun, run, done, reply, objectCodec, tagCodec,
  type Aggregate, type EffectControl } from "@lambda-house/teob-ts/core";
import { canonical, digest, type Identity } from "./version.js";

// Hash the code being executed: TypeScript in development, JavaScript in the package.
const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
export const coreImplementation = Object.fromEntries(["engine", "version", "decision"].map((name) =>
  [name + extension, readFileSync(new URL(name + extension, import.meta.url), "utf8")]));
export const coreId = digest(coreImplementation);
export interface BasePlan<V> { initial: V; rounds: number }
export interface Decision { accepted: boolean; reason: string }
export interface Job {
  id: string;
  key: string;
  input: unknown;
  /** Reserved before execution; cost units are defined by the adapter. */
  costLimit: number;
}
export interface Receipt { output: unknown; cost: number }
export interface Observation { metrics: Record<string, number>; data: unknown }
export interface RunRecord { job: Job; requested: boolean; receipt?: Receipt; observation?: Observation }
export interface Trial<V, E> { round: number; candidate: V; baselineId: string; evaluation: E; accepted: boolean; reason: string }
export interface State<V, P, E> {
  id: string;
  status: "idle" | "running" | "finished" | "failed" | "blocked";
  plan?: P;
  champion?: V;
  pending?: { round: number; candidate: V; runs: RunRecord[] };
  trials: Trial<V, E>[];
  executions: number;
  spent: number;
  coreId?: string;
  adapterId?: string;
  error?: string;
}
export interface Adapter<V extends Identity, P extends BasePlan<V>, E> {
  implementation: unknown;
  validatePlan(plan: P): void;
  validateVersion(version: V): void;
  limits(plan: P): { executions: number; cost: number };
  propose(champion: V, history: Trial<V, E>[], plan: P): V;
  jobs(champion: V, candidate: V, plan: P): Omit<Job, "id">[];
  /** repeatable: safe simulation; idempotent: executor honors job.id; manual: never retry uncertainty. */
  recovery: "repeatable" | "idempotent" | "manual";
  execute(job: Job, plan: P): Promise<Receipt>;
  /** Pure local grading. null means wait for separately delivered feedback. */
  grade(job: Job, receipt: Receipt, plan: P): Observation | null;
  assess(runs: RunRecord[], plan: P): { evaluation: E; decision: Decision };
}
export type Command<V, P, E> =
  | { tag: "start"; plan: P }
  | { tag: "advance"; resume?: boolean }
  | { tag: "received"; jobId: string; receipt: Receipt }
  | { tag: "observed"; jobId: string; observation: Observation }
  | { tag: "execution_failed"; jobId: string; message: string }
  | { tag: "rollback"; versionId: string; reason: string }
  | { tag: "get_state" };
export type Event<V, P, E> =
  | { tag: "experiment_started"; plan: P; implementation: unknown; coreId: string; adapterId: string }
  | { tag: "candidate_proposed"; round: number; candidate: V; jobs: Job[] }
  | { tag: "execution_requested"; jobId: string }
  | { tag: "execution_received"; jobId: string; receipt: Receipt }
  | { tag: "observation_recorded"; jobId: string; observation: Observation }
  | { tag: "candidate_decided"; trial: Trial<V, E> }
  | { tag: "experiment_finished" }
  | { tag: "experiment_failed"; message: string }
  | { tag: "experiment_blocked"; message: string }
  | { tag: "strategy_reverted"; version: V; reason: string };
export type Reply<V, P, E> = { tag: "state"; state: State<V, P, E> } | { tag: "error"; message: string };
export interface LearnerOptions { category?: string }
const tags = ["experiment_started", "candidate_proposed", "execution_requested", "execution_received", "observation_recorded",
  "candidate_decided", "experiment_finished", "experiment_failed", "experiment_blocked", "strategy_reverted"] as const;
const current = <V, P, E>(s: State<V, P, E>) => s.pending?.runs.find((r) => !r.observation);
function validateObservation(o: Observation) {
  canonical(o);
  if (!o.metrics || typeof o.metrics !== "object" || Array.isArray(o.metrics) || Object.values(o.metrics).some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new Error("Invalid observation metrics");
  }
}
export function createLearner<V extends Identity, P extends BasePlan<V>, E>(adapter: Adapter<V, P, E>, options: LearnerOptions = {}) {
  if (!["repeatable", "idempotent", "manual"].includes(adapter.recovery)) throw new Error("Invalid recovery mode");
  const adapterId = digest({ implementation: adapter.implementation, recovery: adapter.recovery });
  type S = State<V, P, E>; type C = Command<V, P, E>; type Ev = Event<V, P, E>; type R = Reply<V, P, E>;
  const name = options.category ?? "learning";
  if (typeof name !== "string" || !name.trim()) throw new Error("Invalid learner category");
  const category = categoryTypes<C, R>(CategoryId(name));
  const validate = (p: P) => {
    canonical(p);
    if (!Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100) throw new Error("Invalid round budget");
    const limits = adapter.limits(structuredClone(p));
    if (!Number.isSafeInteger(limits.executions) || limits.executions < 1 || !Number.isFinite(limits.cost) || limits.cost < 0) throw new Error("Invalid execution budget");
    adapter.validatePlan(structuredClone(p));
    adapter.validateVersion(structuredClone(p.initial));
  };
  async function execute(s: S, job: Job, ctx: EffectControl<C, R>) {
    try {
      const receipt = await adapter.execute(structuredClone(job), structuredClone(s.plan!));
      await ctx.tellSelf({ tag: "received", jobId: job.id, receipt });
    } catch (error) {
      await ctx.tellSelf({ tag: "execution_failed", jobId: job.id, message: (error as Error).message });
    }
  }
  const aggregate: Aggregate<C, R, Ev, S> = {
    category: category.categoryId,
    initial: (id) => ({ id: String(id), status: "idle", trials: [], executions: 0, spent: 0 }),
    async decide(s, command, ctx) {
      const advance = () => ctx.tellSelf({ tag: "advance" });
      switch (command.tag) {
        case "start":
          if (s.status !== "idle") return reply({ tag: "error", message: "Experiment already started" });
          try { validate(command.plan); } catch (e) { return reply({ tag: "error", message: (e as Error).message }); }
          await advance();
          return persist({ tag: "experiment_started", plan: structuredClone(command.plan), coreId, adapterId,
            implementation: { core: coreImplementation, adapter: structuredClone(adapter.implementation) } });
        case "advance": {
          if (s.status !== "running") return done();
          try {
            if (s.coreId !== coreId || s.adapterId !== adapterId) throw new Error("Restore the recorded implementation before resuming");
            validate(s.plan!);
            if (!s.pending) {
              if (s.trials.length >= s.plan!.rounds) return persist({ tag: "experiment_finished" });
              const candidate = adapter.propose(structuredClone(s.champion!), structuredClone(s.trials), structuredClone(s.plan!));
              canonical(candidate);
              adapter.validateVersion(structuredClone(candidate));
              if (candidate.parentId !== s.champion!.id) throw new Error("Candidate must identify its parent");
              const jobs = adapter.jobs(structuredClone(s.champion!), structuredClone(candidate), structuredClone(s.plan!))
                .map((job, i) => ({ ...job, id: `${encodeURIComponent(name)}/${encodeURIComponent(s.id)}/${s.trials.length}/${i}` }));
              canonical(jobs);
              if (!jobs.length || new Set(jobs.map((j) => j.key)).size !== jobs.length || jobs.some((j) => typeof j.key !== "string" || !j.key || !Number.isFinite(j.costLimit) || j.costLimit < 0)) throw new Error("Invalid evaluation jobs");
              const budget = adapter.limits(structuredClone(s.plan!));
              if (s.executions + jobs.length > budget.executions || s.spent + jobs.reduce((n, j) => n + j.costLimit, 0) > budget.cost) throw new Error("Evaluation budget exhausted");
              await advance();
              return persist({ tag: "candidate_proposed", round: s.trials.length, candidate, jobs });
            }
            const record = current(s);
            if (!record) {
              const { evaluation, decision } = adapter.assess(structuredClone(s.pending.runs), structuredClone(s.plan!));
              canonical({ evaluation, decision });
              if (typeof decision.accepted !== "boolean" || typeof decision.reason !== "string") throw new Error("Invalid decision");
              await advance();
              return persist({ tag: "candidate_decided", trial: { round: s.pending.round, candidate: s.pending.candidate,
                baselineId: s.champion!.id, evaluation, accepted: decision.accepted, reason: decision.reason } });
            }
            if (record.receipt) {
              const observation = adapter.grade(structuredClone(record.job), structuredClone(record.receipt), structuredClone(s.plan!));
              if (observation === null) return done();
              validateObservation(observation);
              await advance();
              return persist({ tag: "observation_recorded", jobId: record.job.id, observation });
            }
            if (record.requested && !command.resume) return done();
            if (record.requested && adapter.recovery === "manual") return persist({ tag: "experiment_blocked", message: `Unknown outcome of ${record.job.id}; reconcile its receipt before continuing` });
            const effect = () => execute(s, record.job, ctx);
            return record.requested ? run(effect) : andRun(persist({ tag: "execution_requested", jobId: record.job.id }), effect);
          } catch (e) { return persist({ tag: "experiment_failed", message: (e as Error).message }); }
        }
        case "received": {
          const record = current(s);
          if (!["running", "blocked"].includes(s.status) || record?.job.id !== command.jobId || !record.requested || record.receipt) return done();
          try {
            canonical(command.receipt);
            if (!Number.isFinite(command.receipt.cost) || command.receipt.cost < 0 || command.receipt.cost > record.job.costLimit) throw new Error("Invalid receipt or execution exceeded its cost reservation");
          } catch (e) { return persist({ tag: "experiment_blocked", message: (e as Error).message }); }
          await advance();
          return persist({ tag: "execution_received", jobId: command.jobId, receipt: structuredClone(command.receipt) });
        }
        case "observed": {
          const record = current(s);
          if (s.status !== "running" || record?.job.id !== command.jobId || !record.receipt) return done();
          try { validateObservation(command.observation); } catch (e) { return reply({ tag: "error", message: (e as Error).message }); }
          await advance();
          return persist({ tag: "observation_recorded", jobId: command.jobId, observation: structuredClone(command.observation) });
        }
        case "execution_failed":
          if (s.status !== "running" || current(s)?.job.id !== command.jobId || current(s)?.receipt) return done();
          return persist({ tag: "experiment_blocked", message: command.message });
        case "rollback": {
          if (s.status !== "finished" || !command.reason.trim()) return reply({ tag: "error", message: "Rollback requires a finished experiment and a reason" });
          const version = [s.plan!.initial, ...s.trials.filter((t) => t.accepted).map((t) => t.candidate)].find((v) => v.id === command.versionId);
          if (!version) return reply({ tag: "error", message: "Unknown accepted version" });
          return persist({ tag: "strategy_reverted", version, reason: command.reason });
        }
        case "get_state": return reply({ tag: "state", state: structuredClone(s) });
      }
    },
    apply(s, e) {
      const update = (id: string, patch: Partial<RunRecord>) => ({ ...s.pending!, runs: s.pending!.runs.map((r) => r.job.id === id ? { ...r, ...patch } : r) });
      switch (e.tag) {
        case "experiment_started": return { ...s, status: "running", plan: e.plan, champion: e.plan.initial, coreId: e.coreId, adapterId: e.adapterId };
        case "candidate_proposed": return { ...s, pending: { round: e.round, candidate: e.candidate, runs: e.jobs.map((job) => ({ job, requested: false })) } };
        case "execution_requested": return { ...s, executions: s.executions + 1, pending: update(e.jobId, { requested: true }) };
        case "execution_received": {
          const { error: _, ...rest } = s;
          return { ...rest, status: "running", spent: s.spent + e.receipt.cost, pending: update(e.jobId, { receipt: e.receipt }) };
        }
        case "observation_recorded": return { ...s, pending: update(e.jobId, { observation: e.observation }) };
        case "candidate_decided": {
          const { pending: _, ...rest } = s;
          return { ...rest, champion: e.trial.accepted ? e.trial.candidate : s.champion, trials: [...s.trials, e.trial] };
        }
        case "experiment_finished": return { ...s, status: "finished" };
        case "experiment_failed": return { ...s, status: "failed", error: e.message };
        case "experiment_blocked": return { ...s, status: "blocked", error: e.message };
        case "strategy_reverted": return { ...s, champion: e.version };
      }
    },
    async onRecoveryComplete(s, ctx) { if (s.status === "running") await ctx.tellSelf({ tag: "advance", resume: true }); },
  };
  return { aggregate, category, eventCodec: tagCodec<Ev>(...tags), stateCodec: objectCodec<S>("LearningExperiment") };
}
