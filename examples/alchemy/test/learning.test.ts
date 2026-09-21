import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EntityId } from "@lambda-house/teob-ts/core";
import { loadTable } from "../src/game/table.js";
import { policies } from "../src/game/policies.js";
import { playOffline } from "../src/game/engine.js";
import { freshDb } from "../src/harness.js";
import { emptyMemory, foldAttempts, readJournal } from "../src/memory.js";
import { hashPolicy } from "../src/provenance.js";
import { INITIAL_WEIGHTS, strategyVersion, snapshotMemory, weightedPolicy, proposers, availableFeatures, availableConditions, type Proposer, type Component } from "../src/learning/strategy.js";
import { bootstrap95 } from "../src/learning/statistics.js";
import { alchemyEvaluator } from "../src/learning/alchemy.js";
import { coreId } from "teob-mutara";
import { digest } from "teob-mutara";
import { implementation } from "../src/learning/strategy.js";
import { createExperimentAggregate, decideCandidate, experimentHarness,
  type EpisodeResult, type ExperimentPlan, type Evaluator, type ExperimentEvent } from "../src/learning/experiment.js";

const table = loadTable();
const initial = strategyVersion(INITIAL_WEIGHTS);
const plan = (extra: Partial<ExperimentPlan> = {}): ExperimentPlan => ({
  method: "adaptive", seed: 7, rounds: 2, attempts: 20, trainingSeeds: [1, 2], validationSeeds: [3, 4],
  minimumGain: 1, tableHash: table.hash, memory: snapshotMemory(emptyMemory()), initial, ...extra,
});
const episodes = (seeds: number[], score: number): EpisodeResult[] => seeds.map((seed) =>
  ({ seed, score, attempts: 20, traceHash: `sha256:${seed}:${score}` }));
const synthetic: Evaluator = async (v, seeds) => episodes(seeds, 10 + v.weights.novelty);
const propose: Proposer = (champion) => strategyVersion({ ...champion.weights, novelty: champion.weights.novelty + 1 }, champion.id);
const path = (name: string) => freshDb(join(tmpdir(), `alchemy-learning-${name}-${process.pid}.db`));
const events = (p: string) => readJournal(p).map((r) => JSON.parse(r.payload) as ExperimentEvent);

describe("strategy versions", () => {
  it("validates, canonicalizes and pins component artifacts", () => {
    const terms: Component[] = [{ feature: "recency", weight: 2, when: "early" }, { feature: "novelty", weight: 1, when: "stalled" }];
    const version = strategyVersion(INITIAL_WEIGHTS, initial.id, terms);
    expect(version.id).toBe(strategyVersion(INITIAL_WEIGHTS, initial.id, [...terms].reverse()).id);
    expect(Object.isFrozen(version.components[0])).toBe(true);
    expect(() => strategyVersion(INITIAL_WEIGHTS, null, [terms[0], terms[0]])).toThrow("components");
    expect(() => strategyVersion(INITIAL_WEIGHTS, null, [{ ...terms[0], feature: "constructor" } as never])).toThrow("components");
    expect(() => strategyVersion(INITIAL_WEIGHTS, null, [{ ...terms[0], weight: Infinity }])).toThrow("components");
    expect(() => weightedPolicy({ ...version, components: [] })).toThrow("artifact changed");
    terms[0].weight = 3;
    expect(version.components.find((c) => c.feature === "recency")?.weight).toBe(2);
  });

  it("switches components by game history and still excludes known dead pairs", () => {
    const version = strategyVersion({ productivity: 0, novelty: 0, exploration: 0 }, null,
      [{ feature: "recency", weight: 1, when: "early" }]);
    const policy = weightedPolicy(version);
    const view = { known: ["water", "fire"], tried: new Set<string>(), wins: new Map<string, number>(),
      discoveredAt: new Map([["water", 0], ["fire", 38]]), t: 39, memory: emptyMemory() };
    expect(policy(view, () => 0)).toEqual(["fire", "fire"]);
    expect(policy({ ...view, t: 40 }, () => 0)).toEqual(["water", "water"]);
    view.memory.deadPairs.add("fire + fire");
    expect(policy(view, () => 0)).toEqual(["water", "fire"]);
    const stalled = weightedPolicy(strategyVersion({ productivity: 0, novelty: 0, exploration: 0 }, null,
      [{ feature: "recency", weight: 1, when: "stalled" }]));
    expect(stalled({ ...view, memory: emptyMemory(), t: 47 }, () => 0)).toEqual(["water", "water"]);
    expect(stalled({ ...view, memory: emptyMemory(), t: 48 }, () => 0)).toEqual(["fire", "fire"]);
  });

  it("automatically introduces features, removes terms and composes conditional candidates reproducibly", () => {
    const seen = new Set<string>();
    let removed = false, combined = false, conditional = false;
    for (const method of ["components", "componentsRandom"] as const) {
      let champion = initial;
      for (let round = 0; round < 40; round++) {
        const next = proposers[method](champion, round, 701);
        expect(next).toEqual(proposers[method](champion, round, 701));
        expect(next.parentId).toBe(champion.id);
        expect(() => weightedPolicy(next)).not.toThrow();
        for (const c of next.components) {
          expect(availableFeatures(round)).toContain(c.feature);
          expect(availableConditions(round)).toContain(c.when);
          seen.add(c.feature);
          conditional ||= c.when !== "always";
        }
        removed ||= next.components.length < champion.components.length;
        combined ||= next.components.length > 1;
        champion = next;
      }
    }
    expect([...seen].sort()).toEqual(availableFeatures(40).sort());
    expect([removed, combined, conditional]).toEqual([true, true, true]);
  });
  it("pins closure parameters and rejects changed artifacts", () => {
    const next = strategyVersion({ ...INITIAL_WEIGHTS, novelty: 1 }, initial.id);
    expect(initial.id).toBe(strategyVersion({ exploration: 0, novelty: 0, productivity: 1 }).id);
    expect(hashPolicy(weightedPolicy(initial))).not.toBe(hashPolicy(weightedPolicy(next)));
    expect(Object.isFrozen(initial.weights)).toBe(true);
    expect(() => weightedPolicy({ ...next, weights: INITIAL_WEIGHTS })).toThrow("artifact changed");
    expect(() => strategyVersion({ ...INITIAL_WEIGHTS, exploration: NaN })).toThrow();
  });

  it("starts from the existing heuristic and produces deterministic, different trajectories after mutation", () => {
    const baseline = weightedPolicy(initial);
    const next = weightedPolicy(strategyVersion({ productivity: 0, novelty: 1, exploration: 1 }, initial.id));
    for (let seed = 1; seed <= 3; seed++) {
      const original = playOffline(table, policies.empowerment, seed, 158);
      expect(playOffline(table, baseline, seed, 158).tried).toEqual(original.tried);
    }
    const a = playOffline(table, next, 1, 60);
    expect(a.tried).not.toEqual(playOffline(table, baseline, 1, 60).tried);
    expect(a).toEqual(playOffline(table, next, 1, 60));
  });

  it("holds the prior fixed during evaluation and refuses a different world", async () => {
    const memory = snapshotMemory(foldAttempts([{ a: "water", b: "fire", results: ["steam"] }]));
    const p = plan({ memory });
    const before = JSON.stringify(p);
    const evaluate = alchemyEvaluator(table);
    const a = await evaluate(initial, [1, 2], p);
    expect(a).toEqual(await evaluate(initial, [1, 2], p));
    expect(JSON.stringify(p)).toBe(before);
    expect(a).toHaveLength(2);
    await expect(evaluate(initial, [1], { ...p, tableHash: "different" })).rejects.toThrow("world changed");
  });
});

it("reports a reproducible 95% bootstrap interval with valid paired inputs", () => {
  expect(() => bootstrap95([], 7)).toThrow();
  expect(() => bootstrap95([NaN], 7)).toThrow();
  expect(bootstrap95([3, 3, 3], 7)).toEqual({ low: 3, high: 3 });
  const values = Array.from({ length: 100 }, (_, i) => i);
  const interval = bootstrap95(values, 7);
  expect(interval).toEqual(bootstrap95(values, 7));
  // Normal approximation: 49.5 +/- 1.96 * sqrt(833.25 / 100).
  // Wide enough for bootstrap sampling, narrow enough to catch 1.25% tails.
  expect(interval.low).toBeGreaterThan(43.4);
  expect(interval.low).toBeLessThan(44.4);
  expect(interval.high).toBeGreaterThan(54.6);
  expect(interval.high).toBeLessThan(55.6);
});

describe("acceptance gate", () => {
  const evaluation = {
    baselineTraining: episodes([1, 2], 10), candidateTraining: episodes([1, 2], 12),
    baselineValidation: episodes([3, 4], 10), candidateValidation: episodes([3, 4], 12),
  };
  it("requires improvements on both partitions and a majority of validation games", () => {
    expect(decideCandidate(evaluation, plan()).accepted).toBe(true);
    expect(decideCandidate({ ...evaluation, candidateValidation: episodes([3, 4], 9) }, plan()).accepted).toBe(false);
    expect(decideCandidate({ ...evaluation, candidateTraining: episodes([1, 2], 10) }, plan()).accepted).toBe(false);
    const oneOutlier = [episodes([3], 20)[0], episodes([4], 9)[0]];
    expect(decideCandidate({ ...evaluation, candidateValidation: oneOutlier }, plan()).accepted).toBe(false);
  });
  it("rejects missing, mismatched or invalid evaluation data", () => {
    expect(() => decideCandidate({ ...evaluation, candidateTraining: [] }, plan())).toThrow("unpaired");
    expect(() => decideCandidate({ ...evaluation, candidateValidation: episodes([1, 2], 12) }, plan())).toThrow("unpaired");
    expect(() => decideCandidate({ ...evaluation, candidateTraining: episodes([1, 2], NaN) }, plan())).toThrow("unpaired");
  });
});

describe("TEOB experiment loop", () => {
  it("records candidates before evaluation, adopts winners and uses isolated copies of memory", async () => {
    const db = path("loop");
    let calls = 0;
    const h = experimentHarness(db, async (v, seeds, p) => {
      expect(events(db).at(-1)?.tag).toBe("execution_requested");
      expect(events(db).some((e) => e.tag === "candidate_proposed")).toBe(true);
      expect(p.memory.deadPairs).toEqual([]);
      p.memory.deadPairs.push("mutation must not escape");
      calls++;
      return synthetic(v, seeds, p);
    }, propose);
    await h.start("experiment", plan());
    const state = await h.wait("experiment");
    await h.close();
    expect(calls).toBe(8); // four equal-budget batches per candidate, no hidden test batch
    expect(state.champion?.weights.novelty).toBe(2);
    expect(state.trials.map((t) => t.accepted)).toEqual([true, true]);
    expect(state.trials[1].candidate.parentId).toBe(state.trials[0].candidate.id);
    expect(state.plan?.memory.deadPairs).toEqual([]);
    const aggregate = createExperimentAggregate(synthetic);
    expect(events(db).reduce((s, e) => aggregate.apply(s, e), aggregate.initial(EntityId("experiment")))).toEqual(state);
  });

  it("rejects overlapping development and validation seeds before running anything", async () => {
    const evaluate = vi.fn(synthetic);
    const h = experimentHarness(path("bad-plan"), evaluate);
    await expect(h.start("experiment", plan({ validationSeeds: [2, 3] }))).rejects.toThrow("overlapping");
    await h.close();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("resumes the recorded candidate after interruption, without proposing it again", async () => {
    const db = path("recovery");
    const first = experimentHarness(db, async () => { throw new Error("interrupted"); }, propose);
    await first.start("experiment", plan({ rounds: 1 }));
    await expect(first.wait("experiment")).rejects.toThrow("interrupted");
    await first.close();
    const recorded = events(db).find((e) => e.tag === "candidate_proposed")!;
    const sqlite = new Database(db);
    sqlite.prepare("DELETE FROM journal WHERE manifest = 'experiment_blocked'").run();
    sqlite.close(); // durable prefix of a crash before evaluation was committed
    const proposer = vi.fn(propose);
    const second = experimentHarness(db, synthetic, proposer);
    const state = await second.wait("experiment");
    await second.close();
    expect(proposer).not.toHaveBeenCalled();
    expect(state.trials).toHaveLength(1);
    expect(state.champion?.id).toBe(recorded.tag === "candidate_proposed" ? recorded.candidate.id : "");
    expect(events(db).filter((e) => e.tag === "candidate_proposed")).toHaveLength(1);
  });

  it("ignores duplicate work/completions and refuses a changed implementation", async () => {
    const aggregate = createExperimentAggregate(synthetic);
    const started = aggregate.apply(aggregate.initial(EntityId("x")), {
      tag: "experiment_started", plan: plan(), implementation, coreId,
      adapterId: digest({ implementation, recovery: "repeatable" }),
    });
    const candidate = propose(initial, 0, 7);
    const proposed = aggregate.apply(started, { tag: "candidate_proposed", round: 0, candidate,
      jobs: [{ id: "x/0/0", key: "baselineTraining", input: {}, costLimit: 0 }] });
    const pending = aggregate.apply(proposed, { tag: "execution_requested", jobId: "x/0/0" });
    expect(await aggregate.decide(pending, { tag: "advance" }, {} as never)).toEqual({ tag: "Done" });
    expect(await aggregate.decide(pending, { tag: "received", jobId: "other",
      receipt: { output: {}, cost: 0 } }, {} as never)).toEqual({ tag: "Done" });
    const changed = { ...started, plan: { ...started.plan!, initial: { ...initial, implementationId: "old-code" } } };
    expect(await aggregate.decide(changed, { tag: "advance", resume: true }, {} as never))
      .toMatchObject({ tag: "Persist", events: [{ tag: "experiment_failed" }] });
  });

  it("recovers a completed experiment through a real snapshot", async () => {
    const db = path("snapshot");
    const evaluate: Evaluator = async (_v, seeds) => episodes(seeds, 10);
    const first = experimentHarness(db, evaluate);
    await first.start("experiment", plan({ rounds: 51 })); // exceeds the runtime's snapshot threshold
    const live = await first.wait("experiment");
    await first.close();
    const sqlite = new Database(db, { readonly: true });
    expect((sqlite.prepare("SELECT count(*) AS n FROM snapshots").get() as { n: number }).n).toBeGreaterThan(0);
    sqlite.close();
    const spy = vi.fn(evaluate);
    const second = experimentHarness(db, spy);
    expect(await second.state("experiment")).toEqual(live);
    expect(await second.wait("experiment", 100)).toEqual(live);
    await second.close();
    expect(spy).not.toHaveBeenCalled();
  });
});
