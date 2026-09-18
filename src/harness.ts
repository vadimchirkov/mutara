// Minimal SQLite harness: one runtime, one entity per game.

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
  play(id: string, seed: number, policy: string, attempts: number): Promise<GameState | undefined>;
  close(): Promise<void>;
}

export function harness(db: string, deps: AlchemyDeps): Harness {
  const { runtime } = createSqliteRuntime({ path: db, askTimeoutMs: 10_000 }, [
    registration(createAlchemyAggregate(deps), alchemyEventCodec, alchemyStateCodec),
  ]);

  const ask = async (id: string, cmd: Parameters<typeof runtime.ask>[1]) =>
    runtime.ask(EntityId(id), cmd, alchemyCategory);

  return {
    async play(id, seed, policy, attempts) {
      await runtime.tell(EntityId(id), { tag: "start_game", seed, policy, attempts }, alchemyCategory);
      // One command per attempt: every step is its own journal entry, which is
      // the point — the run is readable back as a sequence of decisions.
      for (let i = 0; i < attempts; i++) {
        await runtime.tell(EntityId(id), { tag: "attempt" }, alchemyCategory);
      }
      const r = await ask(id, { tag: "get_state" });
      return r.ok && r.value.reply?.tag === "state" ? r.value.reply.state : undefined;
    },
    async close() {
      await runtime.shutdown();
    },
  };
}
