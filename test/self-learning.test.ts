import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";

import { type Adapter, type BasePlan, type Receipt } from "../src/engine.js";
import { learnerHarness } from "../src/sqlite.js";
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
      await h.send("score", { tag: "received", jobId: "learning/score/1/0", receipt: { output: 999, cost: 1 } });
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

  it("waits for a job that runs longer than the ask timeout", async () => {
    // TEOB runs the effect inside the entity loop, so get_state queues behind a slow job.
    const execute = async (job: { input: unknown }) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { output: job.input, cost: 1 };
    };
    const h = learnerHarness(path("slow"), adapter({ execute }), { askTimeoutMs: 50 });
    try {
      await h.start("score", plan());
      expect((await h.wait("score")).champion?.config.value).toBe(2);
    } finally { await h.close(); }
  });

  it("waits through slow jobs after startOrResume, bounding inactivity rather than total time", async () => {
    // startOrResume's state read lands behind the first job; wait must not ask-timeout on it,
    // and a campaign longer than the wait timeout succeeds while every job makes progress.
    const execute = async (job: { input: unknown }) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { output: job.input, cost: 1 };
    };
    const limits = { rounds: 4, executions: 4, budget: 4 };
    const h = learnerHarness(path("slow-resume"), adapter({ execute }), { askTimeoutMs: 50 });
    try {
      await h.startOrResume("score", plan(limits));
      expect((await h.wait("score", 400)).champion?.config.value).toBe(4);
    } finally { await h.close(); }

    const stalled = learnerHarness(path("stalled"), adapter({
      execute: async (job) => { await new Promise((resolve) => setTimeout(resolve, 400)); return { output: job.input, cost: 1 }; },
    })); // default ask timeout (1 h): inactivity, not the ask, must end the wait
    try {
      await stalled.startOrResume("score", plan());
      await expect(stalled.wait("score", 150)).rejects.toThrow("no progress");
    } finally { await stalled.close(); }
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

  it("retries a failed repeatable job without counting a second logical execution", async () => {
    let calls = 0;
    const execute = vi.fn(async (job: { input: unknown }) => {
      if (++calls === 1) throw new Error("transient network error");
      return { output: job.input, cost: 1 };
    });
    const h = learnerHarness(path("retry"), adapter({ execute }));
    try {
      await h.start("score", plan());
      await expect(h.wait("score")).rejects.toThrow("transient");
      await expect(h.send("score", { tag: "retry", jobId: "learning/score/0/1" })).rejects.toThrow("No failed job");
      await h.send("score", { tag: "retry", jobId: "learning/score/0/0" });
      const final = await h.wait("score");
      expect(final.champion?.config.value).toBe(2);
      expect([final.executions, final.spent, execute.mock.calls.length]).toEqual([2, 2, 3]);
    } finally { await h.close(); }
  });

  it("refuses retry when a repeated effect is unsafe", async () => {
    const h = learnerHarness(path("retry-manual"), adapter({ recovery: "manual", execute: async () => { throw new Error("timeout"); } }));
    try {
      await h.start("score", plan());
      await expect(h.wait("score")).rejects.toThrow("timeout");
      await expect(h.send("score", { tag: "retry", jobId: "learning/score/0/0" })).rejects.toThrow("manual");
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
      await expect(second.send("score", { tag: "observed", jobId: "learning/score/0/0",
        observation: { metrics: 1 as never, data: 1 } })).rejects.toThrow("metrics");
      await second.send("score", { tag: "observed", jobId: "learning/score/0/0", observation: { metrics: { score: 1 }, data: 1 } });
      const final = await second.wait("score");
      await second.send("score", { tag: "observed", jobId: "learning/score/0/0", observation: { metrics: { score: 999 }, data: 999 } });
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
        await recovered.send("score", { tag: "received", jobId: "learning/score/0/0", receipt: { output: 1, cost: 1 } });
      }
      const final = await recovered.wait("score");
      expect([final.executions, final.spent]).toEqual([1, 1]);
      expect(final.champion?.config.value).toBe(1);
      if (recovery !== "manual") expect(execute.mock.calls[0][0].id).toBe("learning/score/0/0");
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
    const before = readJournal(db);
    const execute = vi.fn(adapter().execute);
    const second = learnerHarness(db, adapter({ implementation: { task: "v2" }, execute }));
    try { await expect(second.wait("score")).rejects.toThrow("recorded implementation"); }
    finally { await second.close(); }
    expect(execute).not.toHaveBeenCalled();
    expect(readJournal(db)).toEqual(before);
    const restored = learnerHarness(db, adapter());
    try { expect((await restored.wait("score")).status).toBe("finished"); }
    finally { await restored.close(); }
  });

  it.each([null, "connection lost"])("journals non-Error executor failures: %j", async (error) => {
    const h = learnerHarness(path(`non-error-${String(error)}`), adapter({ execute: async () => { throw error; } }));
    try {
      await h.start("score", plan());
      await expect(h.wait("score", 1000)).rejects.toThrow(String(error));
      expect((await h.state("score")).status).toBe("blocked");
    } finally { await h.close(); }
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

it("starts once via startOrResume and reuses the finished state", async () => {
  const db = path("start-or-resume");
  const execute = vi.fn(adapter().execute);
  const h = learnerHarness(db, adapter({ execute }));
  try {
    const resumed = await h.startOrResume("score", plan());
    expect(resumed.status).toBe("running");
    const final = await h.wait("score");
    expect(final.champion?.config.value).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
    const again = await h.startOrResume("score", plan());
    expect(again).toEqual(await h.state("score"));
    expect(await h.wait("score")).toEqual(final);
    expect(execute).toHaveBeenCalledTimes(2);
  } finally { await h.close(); }
});

describe("concurrent jobs", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const jobs4: Adapter<V, Plan, number>["jobs"] = (_champion, candidate) =>
    [0, 1, 2, 3].map((i) => ({ key: `s${i}`, input: candidate.config.value * 10 + i, costLimit: 1 }));
  const wide = { rounds: 3, budget: 12, executions: 12 };
  const tracked = (ms: number) => {
    const stats = { active: 0, max: 0, calls: [] as string[] };
    const execute = async (job: { id: string; input: unknown }) => {
      stats.calls.push(job.id);
      stats.max = Math.max(stats.max, ++stats.active);
      await sleep(ms);
      stats.active--;
      return { output: job.input, cost: 1 };
    };
    return { stats, execute };
  };
  const waitFor = async (check: () => Promise<boolean>) => { while (!(await check())) await sleep(5); };

  it("matches sequential results, caps jobs in flight and finishes sooner", async () => {
    const outcome = async (concurrency: number) => {
      const { stats, execute } = tracked(40);
      const h = learnerHarness(path(`parallel-${concurrency}`), adapter({ jobs: jobs4, execute }), { concurrency });
      try {
        const t0 = Date.now();
        await h.start("score", plan(wide));
        const s = await h.wait("score");
        return { s, ms: Date.now() - t0, stats };
      } finally { await h.close(); }
    };
    const one = await outcome(1), four = await outcome(4), two = await outcome(2);
    const summary = ({ s }: typeof one) => ({ champion: s.champion, trials: s.trials, spent: s.spent, executions: s.executions });
    expect(summary(four)).toEqual(summary(one));
    expect(summary(two)).toEqual(summary(one));
    expect([one.stats.max, two.stats.max, four.stats.max]).toEqual([1, 2, 4]);
    expect(four.s.executions).toBe(12);
    expect(four.ms).toBeLessThan(one.ms / 2);
  });

  it("never reserves beyond the budget while jobs run in parallel", async () => {
    const { stats, execute } = tracked(10);
    const h = learnerHarness(path("parallel-budget"), adapter({ jobs: jobs4, execute }), { concurrency: 4 });
    try {
      await h.start("score", plan({ ...wide, budget: 6 }));
      await expect(h.wait("score")).rejects.toThrow("budget exhausted");
      const s = await h.state("score");
      expect([s.executions, s.spent, stats.calls.length]).toEqual([4, 4, 4]);
    } finally { await h.close(); }
  });

  it("drains paid jobs in flight after an early stop and counts their cost", async () => {
    const run = async (concurrency: number) => {
      const assessed: number[] = [];
      const { execute } = tracked(5);
      const h = learnerHarness(path(`parallel-early-${concurrency}`), adapter({
        jobs: (_c, candidate) => Array.from({ length: 8 }, (_, i) => ({ key: `s${i}`, input: candidate.config.value, costLimit: 1 })),
        execute, early: (runs) => runs.length >= 2,
        assess: (runs) => { assessed.push(runs.length); return { evaluation: runs.length, decision: { accepted: true, reason: "early" } }; },
      }), { concurrency });
      try {
        await h.start("score", plan({ rounds: 1, budget: 8, executions: 8 }));
        const s = await h.wait("score");
        return { executions: s.executions, spent: s.spent, assessed };
      } finally { await h.close(); }
    };
    expect(await run(1)).toEqual({ executions: 2, spent: 2, assessed: [2] });
    // Freed slots keep launching until the gate fires, so the count depends on timing; every
    // paid job is still charged and assessed, and the gate stops well short of all 8.
    const parallel = await run(4);
    expect(parallel.executions).toBeGreaterThanOrEqual(4);
    expect(parallel.executions).toBeLessThan(8);
    expect(parallel).toEqual({ executions: parallel.executions, spent: parallel.executions, assessed: [parallel.executions] });
  });

  it("keeps a failed job blocked while its neighbours finish, then retries only it", async () => {
    let calls = 0;
    const execute = vi.fn(async (job: { id: string; input: unknown }) => {
      if (job.id.endsWith("/0/0") && ++calls === 1) throw new Error("transient");
      await sleep(20);
      return { output: job.input, cost: 1 };
    });
    const h = learnerHarness(path("parallel-fail"), adapter({ jobs: jobs4, execute }), { concurrency: 4 });
    try {
      await h.start("score", plan({ ...wide, rounds: 1 }));
      await waitFor(async () => (await h.state("score")).pending!.runs.filter((r) => r.receipt).length === 3);
      const blocked = await h.state("score");
      expect([blocked.status, blocked.unresolved]).toEqual(["blocked", ["learning/score/0/0"]]);
      await h.send("score", { tag: "retry", jobId: "learning/score/0/0" });
      const s = await h.wait("score");
      expect([s.status, s.executions, s.spent, execute.mock.calls.length]).toEqual(["finished", 4, 4, 5]);
    } finally { await h.close(); }
  });

  it.each(["manual", "repeatable"] as const)("recovers several jobs in flight after a crash (%s)", async (recovery) => {
    const db = path(`parallel-crash-${recovery}`);
    // Job 0 completes; jobs 1-3 are still executing when the process dies.
    const first = learnerHarness(db, adapter({ recovery, jobs: jobs4,
      execute: (job) => job.id.endsWith("/0") ? Promise.resolve({ output: job.input, cost: 1 }) : new Promise(() => {}) }), { concurrency: 4 });
    try {
      await first.start("score", plan({ ...wide, rounds: 1 }));
      await waitFor(async () => (await first.state("score")).pending!.runs.some((r) => r.receipt));
    } finally { await first.close(); }
    const lost = [1, 2, 3].map((i) => `learning/score/0/${i}`);
    const { stats, execute } = tracked(5);
    const second = learnerHarness(db, adapter({ recovery, jobs: jobs4, execute }), { concurrency: 4 });
    try {
      if (recovery === "manual") {
        await expect(second.wait("score")).rejects.toThrow(`Unknown outcome of ${lost.join(", ")}`);
        expect((await second.state("score")).unresolved).toEqual(lost);
        for (const [i, jobId] of lost.entries()) {
          await second.send("score", { tag: "received", jobId, receipt: { output: 11 + i, cost: 1 } });
          expect((await second.state("score")).status).toBe(i < 2 ? "blocked" : "running");
        }
      }
      const s = await second.wait("score");
      expect([s.status, s.executions, s.spent]).toEqual(["finished", 4, 4]);
      expect(stats.calls.sort()).toEqual(recovery === "manual" ? [] : lost);
    } finally { await second.close(); }
  });
});
