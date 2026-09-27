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
  /** Jobs blocking the experiment: each needs a receipt (`received`) or a `retry`. */
  unresolved?: string[];
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
  jobs(champion: V, candidate: V, plan: P, round: number): Omit<Job, "id">[];
  /** repeatable: safe simulation; idempotent: executor honors job.id; manual: never retry uncertainty. */
  recovery: "repeatable" | "idempotent" | "manual";
  execute(job: Job, plan: P): Promise<Receipt>;
  /** Pure local grading. null means wait for separately delivered feedback. */
  grade(job: Job, receipt: Receipt, plan: P): Observation | null;
  assess(runs: RunRecord[], plan: P): { evaluation: E; decision: Decision };
  /** Pure. Called with the observed prefix before requesting the next job; true assesses
   * that prefix now and drops the remaining jobs. The decision rule must allow optional stopping. */
  early?(runs: RunRecord[], plan: P): boolean;
}
export type Command<_V, P, _E> =
  | { tag: "start"; plan: P }
  | { tag: "advance"; resume?: boolean }
  | { tag: "received"; jobId: string; receipt: Receipt }
  | { tag: "observed"; jobId: string; observation: Observation }
  | { tag: "execution_failed"; jobId: string; message: string }
  /** Re-run a blocked job whose outcome is unknown; refused in manual recovery. */
  | { tag: "retry"; jobId: string }
  | { tag: "rollback"; versionId: string; reason: string }
  | { tag: "get_state" };
export type Event<V, P, E> =
  | { tag: "experiment_started"; plan: P; implementation: unknown; coreId: string; adapterId: string }
  | { tag: "candidate_proposed"; round: number; candidate: V; jobs: Job[] }
  | { tag: "execution_requested"; jobId: string }
  | { tag: "execution_retried"; jobId: string }
  | { tag: "execution_received"; jobId: string; receipt: Receipt }
  | { tag: "observation_recorded"; jobId: string; observation: Observation }
  | { tag: "candidate_decided"; trial: Trial<V, E> }
  | { tag: "experiment_finished" }
  | { tag: "experiment_failed"; message: string }
  | { tag: "experiment_blocked"; message: string; jobIds?: string[] }
  | { tag: "strategy_reverted"; version: V; reason: string };
export type Reply<V, P, E> = { tag: "state"; state: State<V, P, E> } | { tag: "error"; message: string };
export interface LearnerOptions {
  category?: string;
  /** Jobs of one candidate executing at once (default 1). Operational: not journaled. */
  concurrency?: number;
}
const tags = ["experiment_started", "candidate_proposed", "execution_requested", "execution_retried", "execution_received", "observation_recorded",
  "candidate_decided", "experiment_finished", "experiment_failed", "experiment_blocked", "strategy_reverted"] as const;
const find = <V, P, E>(s: State<V, P, E>, jobId: string) => s.pending?.runs.find((r) => r.job.id === jobId);
/** Requested before this process started or still executing: no receipt yet. */
const awaiting = (r: RunRecord) => r.requested && !r.receipt;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Allow only floating-point roundoff from summing nonnegative costs. */
export function exceedsCost(amount: number, limit: number, terms = 1): boolean {
  return !Number.isFinite(amount) || amount - limit > Number.EPSILON * Math.max(amount, limit) * terms;
}
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
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  const validate = (p: P) => {
    canonical(p);
    if (!Number.isSafeInteger(p.rounds) || p.rounds < 1 || p.rounds > 100) throw new Error("Invalid round budget");
    const limits = adapter.limits(structuredClone(p));
    if (!Number.isSafeInteger(limits.executions) || limits.executions < 1 || !Number.isFinite(limits.cost) || limits.cost < 0) throw new Error("Invalid execution budget");
    adapter.validatePlan(structuredClone(p));
    adapter.validateVersion(structuredClone(p.initial));
  };
  /**
   * TEOB awaits a Run effect inside the entity turn, which would serialize jobs and queue every
   * ask behind them. Jobs are launched and not awaited; each outcome returns through the mailbox
   * as `received` or `execution_failed`, like `ctx.sync`. The request is journaled first.
   */
  const launch = (s: S, jobs: Job[], ctx: EffectControl<C, R>) => async () => { for (const job of jobs) void execute(s, job, ctx); };
  const block = (s: S, message: string, jobIds: string[]) =>
    persist<Ev, R>({ tag: "experiment_blocked", message, jobIds: [...new Set([...(s.unresolved ?? []), ...jobIds])] });
  async function execute(s: S, job: Job, ctx: EffectControl<C, R>) {
    try {
      const receipt = await adapter.execute(structuredClone(job), structuredClone(s.plan!));
      await ctx.tellSelf({ tag: "received", jobId: job.id, receipt });
    } catch (error) {
      await ctx.tellSelf({ tag: "execution_failed", jobId: job.id, message: errorMessage(error) });
    }
  }
  const aggregate: Aggregate<C, R, Ev, S> = {
    category: category.categoryId,
    initial: (id) => ({ id: String(id), status: "idle", trials: [], executions: 0, spent: 0 }),
    async decide(s, command, ctx) {
      // An incompatible reader must not append a terminal event to a recoverable journal.
      if (s.coreId && (s.coreId !== coreId || s.adapterId !== adapterId) &&
          (command.tag !== "get_state" || s.status === "running")) {
        return reply({ tag: "error", message: "Restore the recorded implementation before resuming" });
      }
      const advance = () => ctx.tellSelf({ tag: "advance" });
      switch (command.tag) {
        case "start":
          if (s.status !== "idle") return reply({ tag: "error", message: "Experiment already started" });
          try { validate(command.plan); } catch (e) { return reply({ tag: "error", message: errorMessage(e) }); }
          await advance();
          return persist({ tag: "experiment_started", plan: structuredClone(command.plan), coreId, adapterId,
            implementation: { core: coreImplementation, adapter: structuredClone(adapter.implementation) } });
        case "advance": {
          if (s.status === "blocked" && command.resume) {
            // Jobs that were executing beside the blocking one lost their outcome in the crash.
            const lost = (s.pending?.runs ?? []).filter((r) => awaiting(r) && !s.unresolved?.includes(r.job.id));
            if (!lost.length) return done();
            if (adapter.recovery === "manual") return block(s, `Unknown outcome of ${lost.map((r) => r.job.id).join(", ")}; reconcile each receipt before continuing`, lost.map((r) => r.job.id));
            return run(launch(s, lost.map((r) => r.job), ctx));
          }
          if (s.status !== "running") return done();
          try {
            validate(s.plan!);
            if (!s.pending) {
              if (s.trials.length >= s.plan!.rounds) return persist({ tag: "experiment_finished" });
              const candidate = adapter.propose(structuredClone(s.champion!), structuredClone(s.trials), structuredClone(s.plan!));
              canonical(candidate);
              adapter.validateVersion(structuredClone(candidate));
              if (candidate.parentId !== s.champion!.id) throw new Error("Candidate must identify its parent");
              const jobs = adapter.jobs(structuredClone(s.champion!), structuredClone(candidate), structuredClone(s.plan!), s.trials.length)
                .map((job, i) => ({ ...job, id: `${encodeURIComponent(name)}/${encodeURIComponent(s.id)}/${s.trials.length}/${i}` }));
              canonical(jobs);
              if (!jobs.length || new Set(jobs.map((j) => j.key)).size !== jobs.length || jobs.some((j) => typeof j.key !== "string" || !j.key || !Number.isFinite(j.costLimit) || j.costLimit < 0)) throw new Error("Invalid evaluation jobs");
              const budget = adapter.limits(structuredClone(s.plan!));
              const executions = s.executions + jobs.length;
              const reserved = s.spent + jobs.reduce((n, j) => n + j.costLimit, 0);
              if (executions > budget.executions || exceedsCost(reserved, budget.cost, executions)) throw new Error("Evaluation budget exhausted");
              await advance();
              return persist({ tag: "candidate_proposed", round: s.trials.length, candidate, jobs });
            }
            const runs = s.pending.runs;
            for (const r of runs.filter((r) => r.receipt && !r.observation)) {
              const observation = adapter.grade(structuredClone(r.job), structuredClone(r.receipt!), structuredClone(s.plan!));
              if (observation === null) continue; // delayed feedback arrives as `observed`
              validateObservation(observation);
              await advance();
              return persist({ tag: "observation_recorded", jobId: r.job.id, observation });
            }
            // After recovery nothing executes: every request without a receipt has an unknown outcome.
            const orphans = runs.filter(awaiting);
            if (command.resume && orphans.length) {
              if (adapter.recovery === "manual") return block(s, `Unknown outcome of ${orphans.map((r) => r.job.id).join(", ")}; reconcile each receipt before continuing`, orphans.map((r) => r.job.id));
              return run(launch(s, orphans.map((r) => r.job), ctx));
            }
            // In flight: requested and not observed, so delayed feedback also holds a slot.
            const active = runs.filter((r) => r.requested && !r.observation).length;
            const next = runs.findIndex((r) => !r.observation);
            const prefix = next < 0 ? runs : runs.slice(0, next);
            // Early stop drains paid jobs in flight, then assesses everything observed. Requests
            // form a prefix, so the drained observations are the prefix `early` sees next.
            if (next < 0 || (prefix.length && adapter.early?.(structuredClone(prefix), structuredClone(s.plan!)) === true)) {
              if (active) return done();
              const { evaluation, decision } = adapter.assess(structuredClone(prefix), structuredClone(s.plan!));
              canonical({ evaluation, decision });
              if (typeof decision.accepted !== "boolean" || typeof decision.reason !== "string") throw new Error("Invalid decision");
              await advance();
              return persist({ tag: "candidate_decided", trial: { round: s.pending.round, candidate: s.pending.candidate,
                baselineId: s.champion!.id, evaluation, accepted: decision.accepted, reason: decision.reason } });
            }
            // Budget and execution count for every job were reserved when the candidate was proposed.
            const start = runs.filter((r) => !r.requested).slice(0, concurrency - active).map((r) => r.job);
            if (!start.length) return done();
            return andRun(persist(...start.map((job) => ({ tag: "execution_requested" as const, jobId: job.id }))), launch(s, start, ctx));
          } catch (e) { return persist({ tag: "experiment_failed", message: errorMessage(e) }); }
        }
        case "received": {
          const record = find(s, command.jobId);
          if (!["running", "blocked"].includes(s.status) || !record || !awaiting(record)) return done();
          try {
            canonical(command.receipt);
            if (command.receipt.cost < 0 || exceedsCost(command.receipt.cost, record.job.costLimit)) throw new Error("Invalid receipt or execution exceeded its cost reservation");
          } catch (e) { return block(s, errorMessage(e), [command.jobId]); }
          await advance();
          return persist({ tag: "execution_received", jobId: command.jobId, receipt: structuredClone(command.receipt) });
        }
        case "observed": {
          const record = find(s, command.jobId);
          if (s.status !== "running" || !record?.receipt || record.observation) return done();
          try { validateObservation(command.observation); } catch (e) { return reply({ tag: "error", message: errorMessage(e) }); }
          await advance();
          return persist({ tag: "observation_recorded", jobId: command.jobId, observation: structuredClone(command.observation) });
        }
        case "execution_failed": {
          const record = find(s, command.jobId);
          if (!["running", "blocked"].includes(s.status) || !record || !awaiting(record) || s.unresolved?.includes(command.jobId)) return done();
          return block(s, command.message, [command.jobId]);
        }
        case "retry": {
          const record = find(s, command.jobId);
          if (s.status !== "blocked" || !record || !awaiting(record) || !(s.unresolved ?? [command.jobId]).includes(command.jobId)) return reply({ tag: "error", message: "No failed job to retry" });
          if (adapter.recovery === "manual") return reply({ tag: "error", message: "Retry is unsafe in manual recovery; reconcile the receipt" });
          return andRun(persist({ tag: "execution_retried", jobId: command.jobId }), launch(s, [record.job], ctx));
        }
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
      // Resolving a job unblocks only when no other job is still unresolved.
      const resolve = (id: string): S => {
        const { error, unresolved, ...rest } = s;
        const left = (unresolved ?? []).filter((j) => j !== id);
        return left.length ? { ...rest, status: s.status, error, unresolved: left } as S : { ...rest, status: "running" };
      };
      switch (e.tag) {
        case "experiment_started": return { ...s, status: "running", plan: e.plan, champion: e.plan.initial, coreId: e.coreId, adapterId: e.adapterId };
        case "candidate_proposed": return { ...s, pending: { round: e.round, candidate: e.candidate, runs: e.jobs.map((job) => ({ job, requested: false })) } };
        case "execution_requested": return { ...s, executions: s.executions + 1, pending: update(e.jobId, { requested: true }) };
        case "execution_retried": return resolve(e.jobId);
        case "execution_received": return { ...resolve(e.jobId), spent: s.spent + e.receipt.cost, pending: update(e.jobId, { receipt: e.receipt }) };
        case "observation_recorded": return { ...s, pending: update(e.jobId, { observation: e.observation }) };
        case "candidate_decided": {
          const { pending: _, ...rest } = s;
          return { ...rest, champion: e.trial.accepted ? e.trial.candidate : s.champion, trials: [...s.trials, e.trial] };
        }
        case "experiment_finished": return { ...s, status: "finished" };
        case "experiment_failed": return { ...s, status: "failed", error: e.message };
        case "experiment_blocked": return { ...s, status: "blocked", error: e.message, ...(e.jobIds ? { unresolved: e.jobIds } : {}) };
        case "strategy_reverted": return { ...s, champion: e.version };
      }
    },
    async onRecoveryComplete(s, ctx) { if (s.status === "running") await ctx.tellSelf({ tag: "advance", resume: true }); },
  };
  return { aggregate, category, eventCodec: tagCodec<Ev>(...tags), stateCodec: objectCodec<S>("LearningExperiment") };
}
