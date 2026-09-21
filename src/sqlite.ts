import { EntityId } from "@lambda-house/teob-ts/core";
import { createSqliteRuntime } from "@lambda-house/teob-ts/sqlite";
import { createLearner, type Adapter, type BasePlan, type Command, type LearnerOptions } from "./engine.js";
import type { Identity } from "./version.js";

/** Optional standalone runner. The learner itself can use an application's TEOB runtime. */
export function learnerHarness<V extends Identity, P extends BasePlan<V>, E>(path: string, adapter: Adapter<V, P, E>, options: LearnerOptions = {}) {
  const learner = createLearner(adapter, options);
  const waiters = new Map<string, Set<() => void>>();
  const completed = new Set<string>();
  // The published TEOB runtime recovers an entity when it is first addressed.
  const { runtime } = createSqliteRuntime({ path, askTimeoutMs: 30_000,
    onPersisted(batch) {
      if (batch.records.some((r) => ["experiment_finished", "experiment_failed", "experiment_blocked"].includes(r.manifest))) {
        completed.add(batch.entityId); waiters.get(batch.entityId)?.forEach((resolve) => resolve());
      }
      if (batch.records.some((r) => r.manifest === "execution_received")) completed.delete(batch.entityId);
    },
  }, [learner]);
  const ready = runtime.start();
  async function send(id: string, command: Command<V, P, E>) {
    await ready;
    const r = await runtime.ask(EntityId(id), command, learner.category);
    if (!r.ok) throw new Error(`Cannot send ${command.tag} to experiment ${id}`);
    if (r.value.reply?.tag === "error") throw new Error(r.value.reply.message);
    return r.value.reply;
  }
  async function state(id: string) {
    const r = await send(id, { tag: "get_state" });
    if (r?.tag !== "state") throw new Error(`Cannot read experiment ${id}`);
    return r.state;
  }
  return { state, send,
    start: (id: string, plan: P) => send(id, { tag: "start", plan }),
    // Ensure-started: the `state → start only from idle` pattern every consumer
    // rewrote by hand. Not a reconciliation: resuming with a different plan or
    // adapter fails later at `wait` via the recorded-implementation check,
    // exactly as the manual pattern did.
    async startOrResume(id: string, plan: P) {
      const saved = await state(id);
      if (saved.status === "idle") {
        await send(id, { tag: "start", plan });
        return state(id);
      }
      return saved;
    },
    async wait(id: string, timeoutMs = 300_000) {
      let s = await state(id);
      if (s.status === "running") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake: (() => void) | undefined;
        try {
          if (!completed.has(id)) await new Promise<void>((resolve, reject) => {
            wake = resolve;
            if (!waiters.has(id)) waiters.set(id, new Set());
            waiters.get(id)!.add(resolve);
            timer = setTimeout(() => reject(new Error(`Experiment ${id} timed out`)), timeoutMs);
          });
        }
        finally {
          clearTimeout(timer);
          if (wake) waiters.get(id)?.delete(wake);
          if (!waiters.get(id)?.size) waiters.delete(id);
        }
        s = await state(id);
      }
      if (s.status !== "finished") throw new Error(s.error ?? `Experiment ${id} is ${s.status}`);
      return s;
    },
    close: () => runtime.shutdown(),
  };
}
