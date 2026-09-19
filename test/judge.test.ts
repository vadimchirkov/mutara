import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EntityId } from "@lambda-house/teob-ts/core";
import { judgeRequest, selectedPair, shortlist, typeSafeJudge, validateResponse, type JudgeRequest, type Judgment } from "../src/judge.js";
import { BASE, loadTable, shuffleNames, rng, pairKey } from "../src/game/table.js";
import { policies } from "../src/game/policies.js";
import { initialGame, playOffline, startGame, viewOf } from "../src/game/engine.js";
import { createAlchemyAggregate, type AlchemyEvent } from "../src/aggregate.js";
import { freshDb, harness } from "../src/harness.js";
import { readJournal } from "../src/memory.js";

const table = loadTable();
const db = (name: string) => freshDb(join(tmpdir(), `alchemy-judge-${name}-${process.pid}.db`));
const judgment = (request: JudgeRequest): Judgment => ({
  response: { model: "test-model", usage: { input_tokens: 100, output_tokens: 10 },
    answers: Object.fromEntries(request.state.pairs.map((_, i) => [`p${i}`, { type: "noul", noul: i === 1 ? 0.9 : 0.1 }])) },
  elapsedMs: 1, httpAttempts: 1,
});
const events = (path: string) => readJournal(path).map((r) => JSON.parse(r.payload) as AlchemyEvent);

describe("TypeSafe boundary", () => {
  const request = judgeRequest([...BASE], [["fire", "water"], ["air", "air"]]);

  it("sends the exact request to the documented endpoint and picks the highest Noul", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(judgment(request).response)));
    const result = await typeSafeJudge("test-key", fetcher)(request);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(request);
    expect(selectedPair(request, result.response)).toEqual(["air", "air"]);
    expect(result.httpAttempts).toBe(1);
    expect(JSON.stringify(request)).not.toContain("test-key");
  });

  it("rejects missing, wrong-type and out-of-range scores", () => {
    for (const bad of [null, {}, { ...judgment(request).response, answers: {} },
      { ...judgment(request).response, answers: { p0: { type: "noul", noul: 2 }, p1: { type: "noul", noul: 0 } } }]) {
      expect(() => validateResponse(request, bad)).toThrow("Invalid TypeSafe response");
    }
  });

  it("backs off on explicit throttling, and never hides an authentication failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(judgment(request).response)));
    expect((await typeSafeJudge("test-key", fetcher)(request)).httpAttempts).toBe(2);
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-server-body", { status: 401 }));
    await expect(typeSafeJudge("test-key", rejected)(request)).rejects.toThrow("TypeSafe HTTP 401");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("shortlists unique legal pairs, with the original policy first and no table access", () => {
    const state = startGame(initialGame(), { seed: 1, policy: "empowerment", attempts: 10, tableHash: "x" });
    const view = viewOf(state);
    const first = policies.empowerment(view, rng(1));
    const pairs = shortlist(view, rng(1), 12);
    expect(pairs[0]).toEqual(first);
    expect(pairs).toHaveLength(10);
    expect(new Set(pairs.map((p) => pairKey(...p))).size).toBe(pairs.length);
    expect(view.tried.size).toBe(0);
  });
});

describe("journaled judgments", () => {
  it("persists input before calling the judge, snapshots safely, and replays without effects", async () => {
    const path = db("fold");
    const judge = vi.fn(async (request: JudgeRequest) => {
      const last = events(path).at(-1);
      expect(last).toMatchObject({ tag: "judgment_requested", request });
      return judgment(request);
    });
    const deps = { table, policies, judge };
    const h = harness(path, deps);
    const live = await h.play("g0", 1, "semantic", 70); // second snapshot includes an in-flight request
    await h.close();
    expect(judge).toHaveBeenCalledTimes(70);
    const agg = createAlchemyAggregate(deps);
    const folded = events(path).reduce((s, e) => agg.apply(s, e), agg.initial(EntityId("g0")));
    expect(folded).toEqual(live);
    expect(judge).toHaveBeenCalledTimes(70);
    const recovered = harness(path, deps);
    expect(await recovered.state("g0")).toEqual(live);
    await recovered.close();
    expect(judge).toHaveBeenCalledTimes(70);
  });

  it("recovers the persisted request after a crash before the response commit", async () => {
    const path = db("recovery");
    const first = harness(path, { table, policies, judge: async () => { throw new Error("crash"); } });
    await expect(first.play("g0", 1, "semantic", 2)).rejects.toThrow("crash");
    await first.close();
    const recorded = events(path).find((e) => e.tag === "judgment_requested")!;
    // Keep only the durable prefix that would survive a crash while awaiting inference.
    const sqlite = new Database(path);
    sqlite.prepare("DELETE FROM journal WHERE manifest = 'game_failed'").run();
    sqlite.close();
    const judge = vi.fn(async (request: JudgeRequest) => judgment(request));
    const second = harness(path, { table, policies, judge });
    await second.waitFinished("g0");
    expect((await second.state("g0"))?.t).toBe(2);
    await second.close();
    expect(judge.mock.calls[0][0]).toEqual(recorded.tag === "judgment_requested" ? recorded.request : undefined);
    expect(events(path).filter((e) => e.tag === "pair_tried")).toHaveLength(2);
    expect(events(path).filter((e) => e.tag === "judgment_requested")).toHaveLength(2);
  });

  it("ignores a duplicate completion and rejects a changed world on recovery", async () => {
    const path = db("duplicate");
    const h = harness(path, { table, policies, judge: async (r) => judgment(r) });
    const state = (await h.play("g0", 1, "semantic", 1))!;
    await h.close();
    const agg = createAlchemyAggregate({ table, policies, judge: async (r) => judgment(r) });
    expect(await agg.decide(state, { tag: "judgment_completed", t: 0,
      judgment: judgment(judgeRequest([...BASE], [["fire", "water"]])) }, {} as never)).toEqual({ tag: "Done" });
    const pendingState = { ...state, status: "playing" as const, attempts: 2, pendingJudgment: {
      t: 1, request: judgeRequest([...BASE], [["fire", "water"]]),
    } };
    expect(await agg.decide(pendingState, { tag: "attempt" }, {} as never)).toEqual({ tag: "Done" });
    expect(await agg.decide(pendingState, { tag: "judgment_completed", t: 0,
      judgment: judgment(pendingState.pendingJudgment.request) }, {} as never)).toEqual({ tag: "Done" });
    const changed = createAlchemyAggregate({ table: { ...table, hash: "changed" }, policies });
    const effect = await changed.decide({ ...state, status: "playing", attempts: 2 }, { tag: "attempt" }, {} as never);
    expect(effect).toMatchObject({ tag: "Persist", events: [{ tag: "game_failed" }] });
  });
});

it("name shuffling preserves the starting inventory and heuristic game topology", () => {
  const shuffled = shuffleNames(table, 719);
  expect(new Set(shuffled.elements)).toEqual(new Set(table.elements));
  for (let seed = 1; seed <= 3; seed++) {
    const original = playOffline(table, policies.empowerment, seed, 158);
    const ablated = playOffline(shuffled, policies.empowerment, seed, 158);
    expect(ablated.known.length).toBe(original.known.length);
    expect(ablated.wins.water).toBe(original.wins.water);
  }
});
