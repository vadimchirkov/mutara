// Minimal SQLite harness: one runtime, one entity per game.
//
// The game drives itself once started, so this only starts it and waits for the
// terminal event. `onPersisted` fires synchronously after every journal write,
// which is the runtime's own completion signal — no polling.

import { existsSync, rmSync } from "node:fs";
import { registration } from "@lambda-house/teob-ts/inmem";
import { createSqliteRuntime } from "@lambda-house/teob-ts/sqlite";
import { EntityId } from "@lambda-house/teob-ts/core";
import {
  alchemyCategory,
  alchemyEventCodec,
  alchemyStateCodec,
  createAlchemyAggregate,
  type AlchemyDeps,
} from "./aggregate.js";
import type { GameState } from "./game/engine.js";

export function freshDb(path: string): string {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(p)) rmSync(p);
  return path;
}

export interface Harness {
  /** Start a game and return immediately; the entity drives itself from here. */
  start(id: string, seed: number, policy: string, attempts: number): Promise<void>;
  waitFinished(id: string, timeoutMs?: number): Promise<void>;
  state(id: string): Promise<GameState | undefined>;
  /** start + waitFinished + state, which is what every caller but a crash wants. */
  play(id: string, seed: number, policy: string, attempts: number): Promise<GameState | undefined>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function harness(db: string, deps: AlchemyDeps, timeoutMs = 30_000): Harness {
  const finished = new Set<string>();
  const waiters = new Map<string, () => void>();

  const { runtime } = createSqliteRuntime(
    {
      path: db,
      askTimeoutMs: 10_000,
      recoverEntitiesOnStart: true,
      onPersisted: (b) => {
        for (const r of b.records) {
          if (r.manifest !== "game_finished") continue;
          finished.add(b.entityId);
          waiters.get(b.entityId)?.();
          waiters.delete(b.entityId);
        }
      },
    },
    [registration(createAlchemyAggregate(deps), alchemyEventCodec, alchemyStateCodec)],
  );

  // `recoverEntitiesOnStart` only wakes dormant entities when `start()` is
  // called — without it an interrupted game stays asleep and never resumes.
  const started = runtime.start();

  async function state(id: string) {
    await started;
    const r = await runtime.ask(EntityId(id), { tag: "get_state" }, alchemyCategory);
    return r.ok && r.value.reply?.tag === "state" ? r.value.reply.state : undefined;
  }

  async function start(id: string, seed: number, policy: string, attempts: number) {
    await started;
    await runtime.tell(EntityId(id), { tag: "start_game", seed, policy, attempts }, alchemyCategory);
  }

  async function waitFinished(id: string, ms = timeoutMs) {
    await started;
    if (finished.has(id)) return;
    const done = new Promise<void>((res) => waiters.set(id, res));
    await Promise.race([
      done,
      sleep(ms).then(() => {
        throw new Error(`game ${id} did not finish in ${ms}ms`);
      }),
    ]);
  }

  return {
    state,
    start,
    waitFinished,

    async play(id, seed, policy, attempts) {
      if (attempts === 0) return state(id); // reload-only, used by the snapshot test
      // The waiter is registered before the game starts: a short game can finish
      // inside `tell`, and a waiter installed afterwards would never fire.
      const done = waitFinished(id);
      await start(id, seed, policy, attempts);
      await done;
      return state(id);
    },

    async close() {
      await runtime.shutdown();
    },
  };
}
