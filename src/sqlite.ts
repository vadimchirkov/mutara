import { EntityId } from "@lambda-house/teob-ts/core";
import { createSqliteRuntime } from "@lambda-house/teob-ts/sqlite";
import { createLearner, type Adapter, type BasePlan, type Command, type LearnerOptions } from "./engine.js";
import type { Identity } from "./version.js";

/** An ask that timed out: the entity is busy running a job, not failing. */
class AskTimeout extends Error {}

/**
 * Optional standalone runner. The learner itself can use an application's TEOB runtime.
 *
 * TEOB runs a job's side effect inside the entity's turn, so any ask (including `state`)
 * waits behind a job in flight; `askTimeoutMs` (default 1 h) bounds that wait. `wait` and
 * `startOrResume` follow journal progress instead, so a shorter ask timeout only delays them.
 * Bound hung jobs in the adapter's `execute`.
 */
export function learnerHarness<V extends Identity, P extends BasePlan<V>, E>(path: string, adapter: Adapter<V, P, E>,
  { askTimeoutMs = 3_600_000, ...options }: LearnerOptions & { askTimeoutMs?: number } = {}) {
  const learner = createLearner(adapter, options);
  // Resolved on every persisted batch of an entity; batches persist even while it is busy.
  const progress = new Map<string, Set<() => void>>();
  const completed = new Set<string>();
  // The published TEOB runtime recovers an entity when it is first addressed.
  const { runtime } = createSqliteRuntime({ path, askTimeoutMs,
    onPersisted(batch) {
      if (batch.records.some((r) => ["experiment_finished", "experiment_failed", "experiment_blocked"].includes(r.manifest))) {
        completed.add(batch.entityId);
      }
      if (batch.records.some((r) => ["execution_received", "execution_retried"].includes(r.manifest))) completed.delete(batch.entityId);
      progress.get(batch.entityId)?.forEach((resolve) => resolve());
    },
  }, [learner]);
  const ready = runtime.start();
  async function send(id: string, command: Command<V, P, E>) {
    await ready;
    const r = await runtime.ask(EntityId(id), command, learner.category);
    if (!r.ok) {
      const message = `Cannot send ${command.tag} to experiment ${id}`;
      throw (r.error as { tag?: string } | undefined)?.tag === "Timeout" ? new AskTimeout(message) : new Error(message);
    }
    if (r.value.reply?.tag === "error") throw new Error(r.value.reply.message);
    return r.value.reply;
  }
  async function state(id: string) {
    const r = await send(id, { tag: "get_state" });
    if (r?.tag !== "state") throw new Error(`Cannot read experiment ${id}`);
    return r.state;
  }
  /** Resolve on the entity's next persisted batch, or "timeout" after `timeoutMs` without one. */
  function nextProgress(id: string, timeoutMs: number) {
    let done!: (value: "progress" | "timeout") => void;
    const promise = new Promise<"progress" | "timeout">((resolve) => { done = resolve; });
    const onBatch = () => done("progress");
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    if (!progress.has(id)) progress.set(id, new Set());
    progress.get(id)!.add(onBatch);
    const cancel = () => {
      clearTimeout(timer);
      progress.get(id)?.delete(onBatch);
      if (!progress.get(id)?.size) progress.delete(id);
    };
    return { promise: promise.finally(cancel), cancel };
  }
  const stalled = (id: string, timeoutMs: number) => new Error(`Experiment ${id} made no progress for ${timeoutMs} ms`);
  /**
   * Read state without trusting ask latency: an ask may wait behind a job in flight, so it is
   * raced against journal progress. Each persisted batch extends the wait; `timeoutMs` without
   * one fails. An ask that times out behind a busy entity is simply sent again.
   */
  async function read(id: string, timeoutMs: number) {
    for (;;) {
      const ask = state(id).then((s) => ({ s }), (error: unknown) => ({ error }));
      let outcome: Awaited<typeof ask> | "progress" | "timeout";
      do {
        const next = nextProgress(id, timeoutMs);
        outcome = await Promise.race([ask, next.promise]);
        next.cancel();
        if (outcome === "timeout") throw stalled(id, timeoutMs);
      } while (outcome === "progress");
      if ("s" in outcome) return outcome.s;
      if (!(outcome.error instanceof AskTimeout)) throw outcome.error;
    }
  }
  return { state, send,
    start: (id: string, plan: P) => send(id, { tag: "start", plan }),
    // Ensure-started: the `state → start only from idle` pattern every consumer
    // rewrote by hand. Not a reconciliation: resuming with a different plan or
    // adapter fails later at `wait` via the recorded-implementation check,
    // exactly as the manual pattern did.
    async startOrResume(id: string, plan: P, timeoutMs = 300_000) {
      const saved = await read(id, timeoutMs);
      if (saved.status === "idle") {
        await send(id, { tag: "start", plan });
        return read(id, timeoutMs); // the first job may already hold the entity
      }
      return saved;
    },
    /**
     * Resolve with the finished state; throw if it failed, blocked or is idle. `timeoutMs`
     * bounds inactivity, not total time: it restarts on every journal write, so it only has
     * to exceed the slowest single job.
     */
    async wait(id: string, timeoutMs = 300_000) {
      for (;;) {
        const next = nextProgress(id, timeoutMs); // subscribe before reading
        try {
          const s = await read(id, timeoutMs);
          if (s.status === "finished") return s;
          if (s.status !== "running") throw new Error(s.error ?? `Experiment ${id} is ${s.status}`);
          // Running: sleep until the journal moves, then read again.
          if (!completed.has(id) && await next.promise === "timeout") throw stalled(id, timeoutMs);
        } finally {
          next.cancel();
        }
      }
    },
    close: () => runtime.shutdown(),
  };
}
