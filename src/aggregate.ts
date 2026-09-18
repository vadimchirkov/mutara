// The game as an event-sourced aggregate: one entity per game, one event per
// attempt. The journal is the whole record — state is a pure fold over it, so a
// finished game replays exactly and past games can be read back as a corpus.
//
// `decide` performs no side effects at all. Every node here is pure, which is
// why this bench runs on today's framework and does not wait for effect kinds
// (Stage 2). The judge, when it exists, is the first effect to appear.

import type { Aggregate } from "@lambda-house/teob-ts/core";
import { CategoryId } from "@lambda-house/teob-ts/core";
import { persist, done, reply } from "@lambda-house/teob-ts/core";
import { categoryTypes } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";
import type { Table } from "./game/table.js";
import type { Memory, Policy } from "./game/policies.js";
import { applyStep, initialGame, startGame, step, type GameState } from "./game/engine.js";

export type AlchemyCommand =
  | { tag: "start_game"; seed: number; policy: string; attempts: number }
  | { tag: "attempt" }
  | { tag: "get_state" };

export type AlchemyEvent =
  | {
      tag: "game_started";
      seed: number;
      policy: string;
      attempts: number;
      /** Pins the world this run was played against — the F4 lesson. */
      tableHash: string;
    }
  | { tag: "pair_tried"; a: string; b: string; results: string[]; fresh: string[]; t: number }
  | { tag: "game_finished"; discovered: number; attempts: number };

export type AlchemyReply =
  | { tag: "state"; state: GameState }
  | { tag: "error"; message: string };

export const ALCHEMY = CategoryId("alchemy");
export const alchemyCategory = categoryTypes<AlchemyCommand, AlchemyReply>(ALCHEMY);
export const alchemyEventCodec = tagCodec<AlchemyEvent>(
  "game_started",
  "pair_tried",
  "game_finished",
);
export const alchemyStateCodec = objectCodec<GameState>("AlchemyGameState");

export interface AlchemyDeps {
  table: Table;
  policies: Record<string, Policy>;
  /** Cross-run prior, projected from the journal of earlier games. */
  memory?: Memory;
}

export function createAlchemyAggregate(
  deps: AlchemyDeps,
): Aggregate<AlchemyCommand, AlchemyReply, AlchemyEvent, GameState> {
  return {
    category: ALCHEMY,
    initial: () => initialGame(),

    async decide(state, command) {
      switch (command.tag) {
        case "start_game": {
          if (state.status !== "idle") {
            return reply({ tag: "error", message: `game already ${state.status}` });
          }
          if (!deps.policies[command.policy]) {
            return reply({ tag: "error", message: `unknown policy ${command.policy}` });
          }
          return persist({
            tag: "game_started",
            seed: command.seed,
            policy: command.policy,
            attempts: command.attempts,
            tableHash: deps.table.hash,
          });
        }

        case "attempt": {
          if (state.status !== "playing") return done();
          if (state.t >= state.attempts) {
            return persist({
              tag: "game_finished",
              discovered: state.known.length,
              attempts: state.t,
            });
          }
          const st = step(state, deps.table, deps.policies[state.policy], deps.memory);
          // No pair left to try: the game is over early, not stuck.
          if (!st) {
            return persist({
              tag: "game_finished",
              discovered: state.known.length,
              attempts: state.t,
            });
          }
          const ev = { tag: "pair_tried" as const, ...st, t: state.t };
          return state.t + 1 >= state.attempts
            ? persist<AlchemyEvent, AlchemyReply>(ev, {
                tag: "game_finished",
                discovered: state.known.length + st.fresh.length,
                attempts: state.t + 1,
              })
            : persist(ev);
        }

        case "get_state":
          return reply({ tag: "state", state });
      }
    },

    apply(state, event) {
      switch (event.tag) {
        case "game_started":
          return startGame(state, event.seed, event.policy, event.attempts, event.tableHash);
        case "pair_tried":
          return applyStep(state, event);
        case "game_finished":
          return { ...state, status: "finished" };
      }
    },
  };
}
