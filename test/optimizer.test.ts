import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { optimize, createOptimizer, type OptimizeOptions } from "../src/optimizer.js";
import { compositeDecision } from "../src/multi-metric.js";
import { sequentialDecision } from "../src/decision.js";
import { learnerHarness } from "../src/sqlite.js";
import { sampleRandom, validateSpace } from "../src/search.js";

const options = (extra: Partial<OptimizeOptions> = {}): OptimizeOptions => ({
  id: "quadratic-v1",
  implementation: { executor: "quadratic-v1", evaluator: "squared-error-v1" },
  space: { x: { type: "float", min: -10, max: 10, initial: 5 } },
  metrics: [{ name: "error", direction: "lower", weight: 1 }],
  execute: async (config) => ({ output: { error: (Number(config.x) - 1) ** 2 }, cost: 0 }),
  decision: { mode: "heuristic" },
  recovery: "repeatable",
  budget: { trials: 5 },
  ...extra,
});

// Isolated crash fixtures only; never modify real experiment journals.
function crashBeforeOutcome(storage: string) {
  const db = new Database(storage);
  try { db.prepare("DELETE FROM journal WHERE manifest = 'experiment_blocked'").run(); }
  finally { db.close(); }
}
async function withDatabase(run: (storage: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "mutara-optimizer-test-"));
  try { await run(join(dir, "experiment.db")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("declarative optimizer", () => {
  it("improves a deterministic task and obeys execution and trial budgets", async () => {
    const execute = vi.fn(options().execute);
    const result = await optimize(options({ execute, budget: { trials: 30 } }));
    expect((Number(result.champion.x) - 1) ** 2).toBeLessThan(16);
    expect(result.totalTrials).toBe(30);
    expect(result.executions).toBe(60);
    expect(result.spent).toBe(0);
    expect(execute).toHaveBeenCalledTimes(60);
    expect(result.history.every((h) => h.reason.includes("heuristic"))).toBe(true);
  });

  it("uses fresh paired case indices each round and counts actual cost", async () => {
    const execute = vi.fn(async (_config, context) => ({ output: { error: context.sample }, cost: 0.25 }));
    const result = await optimize(options({ execute, samplesPerTrial: 2, costLimit: 0.5, budget: { trials: 2, cost: 4 } }));
    expect(execute.mock.calls.map(([, context]) => context.sample)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(new Set(execute.mock.calls.map(([, context]) => context.id)).size).toBe(8);
    expect(execute.mock.calls.every(([, context]) => context.costLimit === 0.5)).toBe(true);
    expect(result.spent).toBe(2);
    expect(result.executions).toBe(8);
  });

  it("defaults to the bounded gate instead of promoting a single lucky result", async () => {
    let call = 0;
    const result = await optimize(options({
      decision: undefined, metrics: [metric], budget: { trials: 1 },
      execute: async () => ({ output: { score: call++ }, cost: 0 }),
    }));
    expect(result.history[0].accepted).toBe(false);
    expect(result.champion).toEqual({ x: 5 });
  });

  it.each([[1, true], [0, false]])("sequential gate stops a trial once evidence is decisive (candidate wins: %i)", async (wins, accepted) => {
    const execute = vi.fn(async (config: Record<string, unknown>) => ({ output: { score: Number((config.x !== 5) === !!wins) }, cost: 0 }));
    const result = await optimize(options({ execute, decision: { mode: "sequential" }, metrics: [metric], samplesPerTrial: 200, budget: { trials: 1 } }));
    expect(result.history[0].accepted).toBe(accepted);
    expect(result.history[0].metrics.score).toBeCloseTo(wins);
    expect(result.executions).toBeLessThan(40);
    expect(execute).toHaveBeenCalledTimes(result.executions);
  });

  it("keeps up to 100 trials in one recoverable experiment", async () => {
    expect((await optimize(options({ budget: { trials: 80 } }))).totalTrials).toBe(80);
    await expect(optimize(options({ budget: { trials: 101 } }))).rejects.toThrow("between 1 and 100");
  });

  it("reopens a finished experiment without executions and isolates experiment IDs", async () => withDatabase(async (storage) => {
    const execute = vi.fn(options().execute);
    const opts = options({ execute, storage });
    const first = await optimize(opts);
    expect(await optimize(opts)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(10);
    await optimize({ ...opts, id: "independent" });
    expect(execute).toHaveBeenCalledTimes(20);
    await expect(optimize({ ...opts, implementation: { executor: "changed" } })).rejects.toThrow("changed");
    await expect(optimize({ ...opts, budget: { trials: 6 } })).rejects.toThrow("changed");
    expect(execute).toHaveBeenCalledTimes(20);
  }));

  it("blocks an uncertain paid execution by default and accepts a reconciled receipt", async () => withDatabase(async (storage) => {
    let lost = true;
    const execute = vi.fn(async (config: Record<string, unknown>) => {
      if (lost) { lost = false; throw new Error("lost response"); }
      return { output: { error: Number(config.x) ** 2 }, cost: 1 };
    });
    const opts = options({ storage, execute, recovery: undefined, costLimit: 1, budget: { trials: 1, cost: 2 } });
    await expect(optimize(opts)).rejects.toThrow("lost response");
    crashBeforeOutcome(storage);
    await expect(optimize(opts)).rejects.toThrow("Unknown outcome");
    expect(execute).toHaveBeenCalledTimes(1);
    const { adapter } = createOptimizer(opts);
    const h = learnerHarness(storage, adapter);
    try {
      const state = await h.state(opts.id);
      await h.send(opts.id, { tag: "received", jobId: state.pending!.runs[0].job.id, receipt: { output: { error: 25 }, cost: 1 } });
      await h.wait(opts.id);
    } finally { await h.close(); }
    expect((await optimize(opts)).spent).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  }));

  it("resumes idempotent work with the same job ID and no duplicate logical charge", async () => withDatabase(async (storage) => {
    let lost = true;
    const execute = vi.fn(async () => {
      if (lost) { lost = false; throw new Error("lost response"); }
      return { output: { error: 1 }, cost: 1 };
    });
    const opts = options({ storage, execute, recovery: "idempotent", costLimit: 1, budget: { trials: 1, cost: 2 } });
    await expect(optimize(opts)).rejects.toThrow("lost response");
    crashBeforeOutcome(storage);
    const result = await optimize(opts);
    expect(result.executions).toBe(2);
    expect(result.spent).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
    // Executor receives the same key for the uncertain original and its retry.
    const calls = execute.mock.calls as unknown as [unknown, { id: string }][];
    expect(calls[0][1].id).toBe(calls[1][1].id);
  }));

  it("refuses changed implementation before resuming uncertain work", async () => withDatabase(async (storage) => {
    const opts = options({ storage, execute: async () => { throw new Error("lost response"); } });
    await expect(optimize(opts)).rejects.toThrow("lost response");
    crashBeforeOutcome(storage);
    const execute = vi.fn(options().execute);
    await expect(optimize({ ...opts, execute, implementation: { executor: "v2" } })).rejects.toThrow("recorded implementation");
    expect(execute).not.toHaveBeenCalled();
  }));

  it("stops before an unaffordable trial and blocks an excessive receipt", async () => {
    const execute = vi.fn(async () => ({ output: { error: 1 }, cost: 1 }));
    await expect(optimize(options({ execute, costLimit: 1, budget: { trials: 2, cost: 3 } }))).rejects.toThrow("budget exhausted");
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockClear();
    await expect(optimize(options({ execute, costLimit: 0.5, budget: { trials: 2, cost: 3 } }))).rejects.toThrow("cost reservation");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects missing metrics before spending on the next job", async () => {
    const execute = vi.fn(async () => ({ output: {}, cost: 0 }));
    await expect(optimize(options({ execute }))).rejects.toThrow("Invalid observation");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows decimal cost roundoff but rejects real overspending", async () => {
    const execute = vi.fn(async () => ({ output: { error: 1 }, cost: 0.1 }));
    const result = await optimize(options({ execute, costLimit: 0.1, budget: { trials: 3, cost: 0.6 } }));
    expect(result.executions).toBe(6);
    expect(result.spent).toBeCloseTo(0.6);
    const paired = await optimize(options({ execute, samplesPerTrial: 3, costLimit: 0.1, budget: { trials: 1, cost: 0.6 } }));
    expect(paired.executions).toBe(6);
    const receipt = await optimize(options({ execute: async () => ({ output: { error: 1 }, cost: 0.1 + 0.2 }),
      costLimit: 0.3, budget: { trials: 1, cost: 0.6 } }));
    expect(receipt.spent).toBeCloseTo(0.6);
    execute.mockClear();
    await expect(optimize(options({ execute, costLimit: 0.1, budget: { trials: 3, cost: 0.599 } }))).rejects.toThrow("budget exhausted");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("validates bounds, budgets and decisions before execution", async () => {
    const execute = vi.fn(options().execute);
    for (const change of [
      { space: {} }, { metrics: [] }, { implementation: undefined }, { id: "" },
      { decision: { mode: "bounded" as const } }, { decision: { mode: "heuristic" as const, minimumGain: -1 } },
      { budget: { trials: 1, cost: 1 }, costLimit: 1 },
    ]) await expect(optimize(options({ execute, ...change }))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

const metric = { name: "score", direction: "higher" as const, weight: 1, bounds: { min: 0, max: 1 } };
it("requires evidence even when all observations agree, and honors the declared comparison budget", () => {
  const rule = { mode: "bounded" as const, comparisons: 1 };
  expect(compositeDecision([{ score: 0 }], [{ score: 1 }], [metric], rule).accepted).toBe(false);
  const baseline = Array(100).fill({ score: 0 });
  const candidate = Array(100).fill({ score: 0.4 });
  expect(compositeDecision(baseline, candidate, [metric], rule).accepted).toBe(true);
  expect(compositeDecision(baseline, candidate, [metric], { ...rule, comparisons: 1000 }).accepted).toBe(false);
  expect(() => compositeDecision(baseline, [{ score: 2 }, ...candidate.slice(1)], [metric], rule)).toThrow("Invalid observation");
});

it("sequential gate keeps its false-promotion rate under optional stopping", () => {
  let seed = 1;
  const coin = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 < 0.5 ? 1 : -1;
  let promoted = 0;
  for (let i = 0; i < 200; i++) {
    promoted += Number(sequentialDecision(Array.from({ length: 1000 }, coin), { minimumGain: 0, range: 2, alpha: 0.05, comparisons: 1 }).accepted);
  }
  expect(promoted).toBeLessThanOrEqual(16);
  const clear = sequentialDecision(Array(100).fill(1), { minimumGain: 0, range: 2, alpha: 0.05, comparisons: 1 });
  expect([clear.accepted, clear.final, clear.reason]).toEqual([true, true, expect.stringContaining("n=9")]);
});

it("respects the declared weights and directions when trading quality against cost", () => {
  const metrics = [metric, { name: "cost", direction: "lower" as const, weight: 0.5 }];
  const rule = { mode: "heuristic" as const, comparisons: 1 };
  expect(compositeDecision([{ score: 0.5, cost: 1 }], [{ score: 0.6, cost: 2 }], metrics, rule).accepted).toBe(false);
  expect(compositeDecision([{ score: 0.5, cost: 1 }], [{ score: 0.6, cost: 1 }], metrics, rule).accepted).toBe(true);
});

it("does not promote a candidate when summing finite gains would overflow", () => {
  const baseline = Array(100).fill({ score: 0 });
  const candidate = Array(100).fill({ score: 2e306 });
  const decision = compositeDecision(baseline, candidate,
    [{ ...metric, bounds: { min: 0, max: 2.5e307 } }], { mode: "bounded", comparisons: 1 });
  expect(decision.accepted).toBe(false);
  expect(decision.reason).not.toMatch(/Infinity|NaN/);
});

it("samples canonical key order and handles special names without changing prototypes", () => {
  const a = { type: "int" as const, min: 0, max: 10, initial: 5 };
  const samples = () => { let i = 0; return () => [0.2, 0.8][i++]; };
  expect(sampleRandom({ x: a, y: a }, samples())).toEqual(sampleRandom({ y: a, x: a }, samples()));
  const space = Object.fromEntries([["__proto__", { type: "enum" as const, values: ["a", "b"], initial: "a" }]]);
  expect(Object.hasOwn(sampleRandom(space, () => 0), "__proto__")).toBe(true);
  expect(() => validateSpace({ x: { type: "enum", values: [1] as never, initial: 1 as never } })).toThrow();
});
