// The game as an event-sourced aggregate: one entity per game, one event per
// attempt. The journal is the whole record — state is a pure fold over it, so a
// finished game replays exactly and past games can be read back as a corpus.
//
// Model requests are persisted before the Run effect; replies and the selected
// attempt are committed together. Replaying apply never calls the model.

import type { Aggregate } from "@lambda-house/teob-ts/core";
import { CategoryId } from "@lambda-house/teob-ts/core";
import { persist, done, reply, andRun, run } from "@lambda-house/teob-ts/core";
import { categoryTypes } from "@lambda-house/teob-ts/core";
import { tagCodec, objectCodec } from "@lambda-house/teob-ts/core";
import { rng, type Table } from "./game/table.js";
import type { Policy } from "./game/policies.js";
import type { Memory } from "./memory.js";
import { applyStep, initialGame, startGame, step, viewOf, type GameState } from "./game/engine.js";
import { hashMemory, hashPolicy } from "./provenance.js";
import { JUDGE_MODEL, SHORTLIST_SIZE, judgeRequest, selectedPair, shortlist, type Judge, type JudgeRequest, type Judgment } from "./judge.js";

export type AlchemyCommand =
  | { tag: "start_game"; seed: number; policy: string; attempts: number }
  | { tag: "attempt"; resume?: boolean }
  | { tag: "judgment_completed"; t: number; judgment: Judgment }
  | { tag: "judgment_failed"; t: number; message: string }
  | { tag: "get_state" };

export type AlchemyEvent =
  | {
      tag: "game_started";
      seed: number;
      policy: string;
      attempts: number;
      /** Pins the world this run was played against — the F4 lesson. */
      tableHash: string;
      /** Pins the code behind `policy`, which the name alone does not. */
      policyHash: string;
      /** Pins the prior this run started from, or "none". */
      memoryHash: string;
      judgeConfig?: GameState["judgeConfig"];
    }
  | { tag: "pair_tried"; a: string; b: string; results: string[]; fresh: string[]; t: number }
  | { tag: "judgment_requested"; t: number; request: JudgeRequest }
  | { tag: "judgment_received"; t: number; judgment: Judgment }
  | { tag: "game_failed"; message: string }
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
  "judgment_requested",
  "judgment_received",
  "game_failed",
);
export const alchemyStateCodec = objectCodec<GameState>("AlchemyGameState");

export interface AlchemyDeps {
  table: Table;
  policies: Record<string, Policy>;
  /** Cross-run prior, projected from the journal of earlier games. */
  memory?: Memory;
  judge?: Judge;
  judgeConfig?: GameState["judgeConfig"];
}

export function createAlchemyAggregate(
  deps: AlchemyDeps,
): Aggregate<AlchemyCommand, AlchemyReply, AlchemyEvent, GameState> {
  return {
    category: ALCHEMY,
    initial: () => initialGame(),

    async decide(state, command, ctx) {
      switch (command.tag) {
        case "start_game": {
          if (state.status !== "idle") {
            return reply({ tag: "error", message: `game already ${state.status}` });
          }
          if (!Number.isSafeInteger(command.attempts) || command.attempts < 1 || !Number.isSafeInteger(command.seed)) {
            return reply({ tag: "error", message: "seed must be an integer and attempts a positive integer" });
          }
          const semantic = command.policy === "semantic";
          const policy = deps.policies[semantic ? "empowerment" : command.policy];
          if (!policy) {
            return reply({ tag: "error", message: `unknown policy ${command.policy}` });
          }
          if (semantic && !deps.judge) return reply({ tag: "error", message: "semantic policy needs a judge" });
          const config = deps.judgeConfig ?? { model: JUDGE_MODEL, shortlist: SHORTLIST_SIZE };
          if (semantic && (!config.model.trim() || !Number.isSafeInteger(config.shortlist) ||
              config.shortlist < 1 || config.shortlist > 64)) {
            return reply({ tag: "error", message: "Judge needs a model and shortlist of 1..64 pairs" });
          }
          // The entity drives its own game from here; nothing outside it has to
          // remember to keep sending attempts.
          await ctx.tellSelf({ tag: "attempt" });
          return persist({
            tag: "game_started",
            seed: command.seed,
            policy: command.policy,
            attempts: command.attempts,
            tableHash: deps.table.hash,
            policyHash: hashPolicy(policy),
            memoryHash: hashMemory(deps.memory),
            ...(semantic ? { judgeConfig: config } : {}),
          });
        }

        case "attempt": {
          if (state.status !== "playing") return done();
          // A duplicate queued attempt must not issue another paid request.
          if (state.pendingJudgment && !command.resume) return done();
          const finish = (discovered: number, attempts: number): AlchemyEvent => ({
            tag: "game_finished",
            discovered,
            attempts,
          });
          if (state.t >= state.attempts) return persist(finish(state.known.length, state.t));

          const policy = deps.policies[state.judgeConfig ? "empowerment" : state.policy];
          if (!policy || state.tableHash !== deps.table.hash || state.policyHash !== hashPolicy(policy) ||
              state.memoryHash !== hashMemory(deps.memory)) {
            return persist({ tag: "game_failed", message: "Decision inputs changed; restore the recorded table, policy and memory" });
          }
          if (state.judgeConfig) {
            if (!deps.judge) return persist({ tag: "game_failed", message: "Judge unavailable" });
            const pairs = state.pendingJudgment?.request.state.pairs ?? shortlist(
              viewOf(state, deps.memory), rng((state.seed + state.t * 0x9e3779b9) | 0), state.judgeConfig.shortlist, policy,
            );
            if (!pairs.length) return persist(finish(state.known.length, state.t));
            const request = state.pendingJudgment?.request ?? judgeRequest(state.known, pairs, state.judgeConfig.model);
            const effect = async () => {
              let judgment: Judgment;
              try {
                judgment = await deps.judge!(request);
                selectedPair(request, judgment.response); // validate before accepting any result
              } catch (error) {
                await ctx.tellSelf({ tag: "judgment_failed", t: state.t,
                  message: error instanceof Error ? error.message : "Judge failed" });
                return;
              }
              await ctx.tellSelf({ tag: "judgment_completed", t: state.t, judgment });
            };
            return state.pendingJudgment ? run(effect) :
              andRun(persist({ tag: "judgment_requested", t: state.t, request }), effect);
          }

          const st = step(state, deps.table, deps.policies[state.policy], deps.memory);
          // No pair left to try: the game is over early, not stuck.
          if (!st) return persist(finish(state.known.length, state.t));

          const ev: AlchemyEvent = { tag: "pair_tried", ...st, t: state.t };
          if (state.t + 1 >= state.attempts) {
            return persist(ev, finish(state.known.length + st.fresh.length, state.t + 1));
          }
          await ctx.tellSelf({ tag: "attempt" });
          return persist(ev);
        }

        case "judgment_completed": {
          if (state.status !== "playing" || state.pendingJudgment?.t !== command.t || state.t !== command.t) return done();
          const pair = selectedPair(state.pendingJudgment.request, command.judgment.response);
          const st = step(state, deps.table, () => pair);
          if (!st) return done();
          const events: AlchemyEvent[] = [
            { tag: "judgment_received", t: state.t, judgment: command.judgment },
            { tag: "pair_tried", ...st, t: state.t },
          ];
          if (state.t + 1 >= state.attempts) {
            events.push({ tag: "game_finished", discovered: state.known.length + st.fresh.length, attempts: state.t + 1 });
          } else await ctx.tellSelf({ tag: "attempt" });
          return persist(...events);
        }

        case "judgment_failed":
          if (state.status !== "playing" || state.pendingJudgment?.t !== command.t) return done();
          return persist({ tag: "game_failed", message: command.message });

        case "get_state":
          // A copy: the caller must not be able to mutate the entity's state.
          return reply({ tag: "state", state: structuredClone(state) });
      }
    },

    apply(state, event) {
      switch (event.tag) {
        case "game_started":
          return startGame(state, event);
        case "pair_tried":
          return applyStep(state, event);
        case "judgment_requested":
          return { ...state, pendingJudgment: { t: event.t, request: event.request } };
        case "judgment_received": {
          const { pendingJudgment: _, ...rest } = state;
          return rest;
        }
        case "game_failed":
          return { ...state, status: "failed", error: event.message };
        case "game_finished":
          return { ...state, status: "finished" };
      }
    },

    /**
     * A game interrupted mid-run resumes itself. Without this the entity sits in
     * `playing` forever after a restart — the F7/F11 failure, one level down.
     */
    async onRecoveryComplete(state, ctx) {
      if (state.status === "playing") await ctx.tellSelf({ tag: "attempt", resume: true });
    },

    // Checked by `replayAndVerify` over a recorded journal, not on the hot path.
    invariants: [
      {
        name: "no duplicate discoveries",
        check: (s) => new Set(s.known).size === s.known.length,
      },
      {
        name: "one tried pair per attempt",
        check: (s) => s.tried.length === s.t,
      },
      {
        name: "attempts stay within budget",
        check: (s) => s.t <= s.attempts,
      },
    ],
  };
}
