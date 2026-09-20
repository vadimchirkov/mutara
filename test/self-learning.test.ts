import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";

import { createLearner, type Adapter, type BasePlan, type Receipt } from "../src/engine.js";
import { learnerHarness } from "../src/sqlite.js";
import { EntityId } from "@lambda-house/teob-ts/core";
import { createInMemoryRuntime } from "@lambda-house/teob-ts/inmem";
import { boundedDecision } from "../src/decision.js";
import { canonical, digest, version, validateVersion, type Version } from "../src/version.js";

type V = Version<{ value: number }>;
interface Plan extends BasePlan<V> { budget: number; executions: number }
const implementation = { task: "synthetic-score-v1" };
const implementationId = digest(implementation);
const initial = version({ value: 0 }, implementationId);
const plan = (extra: Partial<Plan> = {}): Plan => ({ initial, rounds: 2, budget: 2, executions: 2, ...extra });
const adapter = (extra: Partial<Adapter<V, Plan, number>> = {}): Adapter<V, Plan, number> => ({
  implementation,
  validatePlan: () => {},
  validateVersion: (v) => validateVersion(v, implementationId),
  limits: (p) => ({ executions: p.executions, cost: p.budget }),
  recovery: "repeatable",
  propose: (champion) => version({ value: champion.config.value + 1 }, implementationId, champion.id),
  jobs: (_champion, candidate) => [{ key: "score", input: candidate.config.value, costLimit: 1 }],
  execute: async (job) => ({ output: job.input, cost: 1 }),
  grade: (_job, receipt) => ({ metrics: { score: Number(receipt.output) }, data: receipt.output }),
  assess: (runs) => ({ evaluation: Number(runs[0].observation!.data), decision: { accepted: true, reason: "higher score" } }),
  ...extra,
});
const path = (name: string) => {
  const db = join(tmpdir(), `mutara-${name}-${process.pid}.db`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
  return db;
};
const readJournal = (path: string): { manifest: string }[] => {
  const db = new Database(path, { readonly: true });
  try { return db.prepare("SELECT manifest FROM journal").all() as { manifest: string }[]; }
  finally { db.close(); }
};
function crashPrefix(db: string, terminal: string) {
  const sqlite = new Database(db);
  try { sqlite.prepare("DELETE FROM journal WHERE manifest = ?").run(terminal); }
  finally { sqlite.close(); }
}

describe("generic learning lifecycle", () => {
  it("learns outside Alchemy, accounts for cost, rejects duplicate receipts and journals rollback", async () => {
    const db = path("loop");
    const h = learnerHarness(db, adapter());
    let final;
    try {
      await h.start("score", plan());
      final = await h.wait("score");
      expect(final.champion?.config.value).toBe(2);
      expect([final.executions, final.spent]).toEqual([2, 2]);
      await h.send("score", { tag: "received", jobId: "score/1/0", receipt: { output: 999, cost: 1 } });
      expect(await h.state("score")).toEqual(final);
      await expect(h.send("score", { tag: "rollback", versionId: "unknown", reason: "regression" })).rejects.toThrow("Unknown");
      await h.send("score", { tag: "rollback", versionId: initial.id, reason: "regression" });
      final = await h.state("score");
      expect(final.champion).toEqual(initial);
      expect(final.trials).toHaveLength(2);
    } finally { await h.close(); }
    const evaluate = vi.fn(adapter().execute);
    const reopened = learnerHarness(db, adapter({ execute: evaluate }));
    try { expect(await reopened.wait("score")).toEqual(final); }
    finally { await reopened.close(); }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([{ budget: 1 }, { executions: 1 }])("stops before exceeding reservations: %j", async (limits) => {
    const execute = vi.fn(adapter().execute);
    const h = learnerHarness(path(`budget-${Object.keys(limits)[0]}`), adapter({ execute }));
    try {
      await h.start("score", plan(limits));
      await expect(h.wait("score")).rejects.toThrow("budget exhausted");
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await h.state("score")).spent).toBe(1);
    } finally { await h.close(); }
  });

  it("blocks an over-reservation receipt and does not execute more jobs", async () => {
    const execute = vi.fn(async () => ({ output: 1, cost: 2 }));
    const h = learnerHarness(path("overrun"), adapter({ execute }));
    try {
      await h.start("score", plan());
      await expect(h.wait("score")).rejects.toThrow("cost reservation");
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await h.state("score")).status).toBe("blocked");
    } finally { await h.close(); }
  });

  it("recovers saved receipts without re-executing jobs and accepts delayed feedback", async () => {
    const db = path("feedback");
    const execute = vi.fn(adapter().execute);
    let graded!: () => void;
    const grading = new Promise<void>((resolve) => { graded = resolve; });
    const a = adapter({ execute, grade: () => { graded(); return null; } });
    const first = learnerHarness(db, a);
    try {
      await first.start("score", plan({ rounds: 1 }));
      await grading;
      expect((await first.state("score")).pending?.runs[0].receipt).toEqual({ output: 1, cost: 1 });
    } finally { await first.close(); }
    const second = learnerHarness(db, a);
    try {
      await expect(second.send("score", { tag: "observed", jobId: "score/0/0",
        observation: { metrics: 1 as never, data: 1 } })).rejects.toThrow("metrics");
      await second.send("score", { tag: "observed", jobId: "score/0/0", observation: { metrics: { score: 1 }, data: 1 } });
      const final = await second.wait("score");
      await second.send("score", { tag: "observed", jobId: "score/0/0", observation: { metrics: { score: 999 }, data: 999 } });
      expect(await second.state("score")).toEqual(final);
      expect(final.champion?.config.value).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { await second.close(); }
  });

  it.each(["repeatable", "idempotent", "manual"] as const)("recovers uncertain work using %s semantics", async (recovery) => {
    const db = path(`recovery-${recovery}`);
    const uncertain = learnerHarness(db, adapter({ recovery, execute: async () => { throw new Error("connection lost"); } }));
    try {
      await uncertain.start("score", plan({ rounds: 1 }));
      await expect(uncertain.wait("score")).rejects.toThrow("connection lost");
    } finally { await uncertain.close(); }
    crashPrefix(db, "experiment_blocked"); // crash after request, before its outcome is known
    const execute = vi.fn(adapter().execute);
    const recovered = learnerHarness(db, adapter({ recovery, execute }));
    try {
      if (recovery === "manual") {
        await expect(recovered.wait("score")).rejects.toThrow("Unknown outcome");
        expect(execute).not.toHaveBeenCalled();
        await recovered.send("score", { tag: "received", jobId: "score/0/0", receipt: { output: 1, cost: 1 } });
      }
      const final = await recovered.wait("score");
      expect([final.executions, final.spent]).toEqual([1, 1]);
      expect(final.champion?.config.value).toBe(1);
      if (recovery !== "manual") expect(execute.mock.calls[0][0].id).toBe("score/0/0");
      expect(readJournal(db).filter((e) => e.manifest === "candidate_proposed")).toHaveLength(1);
    } finally { await recovered.close(); }
  });

  it("refuses to resume with a different adapter implementation", async () => {
    const db = path("changed");
    const first = learnerHarness(db, adapter({ execute: async () => { throw new Error("interrupted"); } }));
    try {
      await first.start("score", plan());
      await expect(first.wait("score")).rejects.toThrow("interrupted");
    } finally { await first.close(); }
    crashPrefix(db, "experiment_blocked");
    const execute = vi.fn(adapter().execute);
    const second = learnerHarness(db, adapter({ implementation: { task: "v2" }, execute }));
    try { await expect(second.wait("score")).rejects.toThrow("recorded implementation"); }
    finally { await second.close(); }
    expect(execute).not.toHaveBeenCalled();
  });

  it("wakes concurrent waiters after an asynchronous execution", async () => {
    let finish!: (receipt: Receipt) => void;
    const result = new Promise<Receipt>((resolve) => { finish = resolve; });
    const h = learnerHarness(path("waiters"), adapter({ execute: () => result }));
    try {
      await h.start("score", plan({ rounds: 1 }));
      const a = h.wait("score", 1000), b = h.wait("score", 1000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      finish({ output: 1, cost: 1 });
      const states = await Promise.all([a, b]);
      expect(states[0]).toEqual(states[1]);
      expect(states[0].status).toBe("finished");
    } finally { await h.close(); }
  });

  it("isolates persisted plans and candidates from adapter mutations", async () => {
    const h = learnerHarness(path("isolation"), adapter({
      limits: (p) => {
        const limits = { executions: p.executions, cost: p.budget };
        p.budget = 0;
        return limits;
      },
      validateVersion: (v) => {
        validateVersion(v, implementationId);
        v.config.value = 999;
      },
      assess: (runs) => ({ evaluation: Number(runs[0].observation!.data),
        decision: { accepted: true, reason: "score", candidate: initial, round: 999 } }),
    }));
    try {
      await h.start("score", plan());
      const state = await h.wait("score");
      expect(state.plan?.budget).toBe(2);
      expect(state.champion?.config.value).toBe(2);
      expect(state.trials.map((t) => t.evaluation)).toEqual([1, 2]);
      expect(state.trials.map((t) => t.round)).toEqual([0, 1]);
    } finally { await h.close(); }
  });
});

it("pins finite JSON versions and rejects tampered artifacts", () => {
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  expect(() => canonical({ a: undefined })).toThrow("finite JSON");
  expect(() => canonical([Infinity])).toThrow("finite JSON");
  expect(() => validateVersion({ ...initial, config: { value: 9 } }, implementationId)).toThrow("changed");
  expect(() => validateVersion(initial, "v2")).toThrow("changed");
});

it("uses a bounded confidence gate with a multiple-comparison penalty", () => {
  const options = { minimumGain: 0, range: 2, alpha: 0.05, comparisons: 1 };
  const gains = Array(100).fill(0.4);
  expect(boundedDecision(gains, options).accepted).toBe(true);
  expect(boundedDecision(gains, { ...options, comparisons: 1000 }).accepted).toBe(false);
  expect(boundedDecision(Array(100).fill(0), options).accepted).toBe(false);
  expect(() => boundedDecision([2], options)).toThrow("Invalid");
});
