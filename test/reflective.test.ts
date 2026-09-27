import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  optimizeReflective,
  buildReflectionPrompt,
  paretoFrontier,
  selectParent,
  type PromptSet,
  type ReflectiveCase,
  type ReflectiveOptions,
} from "../src/reflective.js";

function withDir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "mutara-reflective-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Scripted wiring fixture (not a benchmark): topic keywords in the prompt
// decide classification; the stub reflector appends one missing topic.
const topics = ["alpha", "beta"];
function cases(): ReflectiveCase[] {
  const out: ReflectiveCase[] = [];
  for (const split of ["train", "validation"] as const) {
    topics.forEach((topic, i) => {
      out.push({ id: `${split}-yes-${i}`, split, input: { topic }, expected: "handled" });
      out.push({ id: `${split}-no-${i}`, split, input: { topic: `other-${split}-${i}` }, expected: "missed" });
    });
  }
  return out;
}

const baseOptions = (storage: string, extra: Partial<ReflectiveOptions> = {}): ReflectiveOptions => ({
  id: "reflective-v1",
  storage,
  implementation: { task: "keyword-fixture-v1", reflector: "stub-append-v1" },
  initialPrompt: "base prompt.",
  objective: "Handle alpha and beta topics; miss everything else.",
  cases: cases(),
  run: async (prompt, c) => ({
    output: prompt.includes(String((c.input as { topic: string }).topic)) ? "handled" : "missed",
    cost: 0,
  }),
  score: (receipt, c) => ({ score: Number(receipt.output === c.expected), violation: 0 }),
  reflect: async ({ parentPrompt, failures }) => {
    const missing = topics.find((t) =>
      !parentPrompt.includes(t) &&
      (failures.length === 0 || failures.some((f) => (f.input as { topic: string }).topic === t)));
    return { text: missing ? `${parentPrompt} ${missing}` : `${parentPrompt}!`, cost: 0 };
  },
  recovery: "repeatable",
  ...extra,
});

describe("reflective GEPA-style optimization", () => {
  it("seeds, screens and gates improving reflections, then stops when train is solved", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const result = await optimizeReflective({ ...baseOptions(storage), budget: undefined, rounds: 3 });
      expect(result.champion).toBe("base prompt. alpha beta");
      expect(result.history.map((h) => h.accepted)).toEqual([true, true]);
      expect(result.history.every((h) => h.screened && h.evaluated)).toBe(true);
      expect(result.stopReason).toMatch("No train failures");
      expect(result.reflectionCalls).toBe(2);
      // Seed runs every case once; each round runs the candidate once per case (screen + select), plus reflection.
      expect(result.executions).toBe(cases().length + 2 * (1 + cases().length));
      expect(result.spent).toBe(0);
      expect(result.frontier.map((e) => e.prompt)).toEqual([result.champion]);
    });
  });

  it("reopens finished rounds without new model calls and rejects changed options", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const run = vi.fn(baseOptions(storage).run);
      const reflect = vi.fn(baseOptions(storage).reflect);
      const opts = { ...baseOptions(storage), run, reflect, rounds: 2 };
      const first = await optimizeReflective(opts);
      const runCalls = run.mock.calls.length;
      const reflectCalls = reflect.mock.calls.length;
      expect(await optimizeReflective(opts)).toEqual(first);
      expect(run.mock.calls.length).toBe(runCalls);
      expect(reflect.mock.calls.length).toBe(reflectCalls);
      await expect(optimizeReflective({ ...opts, objective: "Changed objective" })).rejects.toThrow("changed");
      expect(run.mock.calls.length).toBe(runCalls);
    });
  });

  it("screens out a regressing reflection before the full evaluation", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const result = await optimizeReflective({
        ...baseOptions(storage),
        rounds: 1,
        reflect: async ({ parentPrompt }) => ({ text: `${parentPrompt} worse`, cost: 1 }),
        costLimit: 1,
        reflectionCostLimit: 1,
        budget: { cost: 100 },
      });
      expect(result.history[0]).toMatchObject({ screened: true, evaluated: false, accepted: false });
      expect(result.history[0]!.reason).toMatch("Screen rejected");
      expect(result.champion).toBe("base prompt.");
      expect(result.spent).toBe(1);
      expect(result.executions).toBe(cases().length + 1 + 2);
    });
  });

  it("rejects a candidate that passes the screen but does not beat the champion overall", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const result = await optimizeReflective({
        ...baseOptions(storage),
        rounds: 1,
        // Fixes alpha but starts handling a negative train case: train mean ties the champion.
        reflect: async ({ parentPrompt }) => ({ text: `${parentPrompt} alpha other-train-0`, cost: 0 }),
      });
      expect(result.history[0]).toMatchObject({ screened: true, evaluated: true, accepted: false });
      expect(result.history[0]!.train).toMatchObject({ baselineMean: 0.5, candidateMean: 0.5 });
      expect(result.champion).toBe("base prompt.");
    });
  });

  it("gates pareto-sampled children against the champion, not their parent", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const three = ["alpha", "beta", "gamma"];
      const threeCases: ReflectiveCase[] = [];
      for (const split of ["train", "validation"] as const) {
        three.forEach((topic) => threeCases.push({ id: `${split}-${topic}`, split, input: { topic }, expected: "handled" }));
        threeCases.push({ id: `${split}-no`, split, input: { topic: "other" }, expected: "missed" });
      }
      const result = await optimizeReflective({
        ...baseOptions(storage),
        cases: threeCases,
        parentStrategy: "pareto",
        seed: 1,
        rounds: 8,
        // Lateral moves: keep only the first failing topic, or append it to single-topic prompts.
        reflect: async ({ parentPrompt, failures, round }) => {
          const topic = (failures[0]!.input as { topic: string }).topic;
          return { text: round % 2 ? `${parentPrompt} ${topic}` : `focus ${topic}`, cost: 0 };
        },
      });
      // Round 3 samples a lateral frontier parent; its child beats that parent but only ties the champion.
      expect(result.history[3]).toMatchObject({ parentPrompt: "focus gamma", championPrompt: "focus alpha beta",
        candidatePrompt: "focus gamma alpha", evaluated: true, accepted: false });
      let champion = { train: 0, validation: 0 };
      for (const h of result.history.filter((h) => h.evaluated)) {
        if (!h.accepted) continue;
        expect(h.train.candidateMean!).toBeGreaterThan(h.train.baselineMean);
        expect(h.validation.candidateMean!).toBeGreaterThan(h.validation.baselineMean);
        expect(h.validation.candidateMean!).toBeGreaterThan(champion.validation);
        champion = { train: h.train.candidateMean!, validation: h.validation.candidateMean! };
      }
    });
  });

  it("feeds real seed failures and evaluator feedback to the reflector, never expected to the runner", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const inputs: Parameters<ReflectiveOptions["reflect"]>[0][] = [];
      const runnerKeys = new Set<string>();
      const opts = baseOptions(storage);
      await optimizeReflective({
        ...opts,
        rounds: 1,
        passScore: 10,
        run: async (prompt, c, ctx) => {
          Object.keys(c).forEach((k) => runnerKeys.add(k));
          return opts.run(prompt, c, ctx);
        },
        score: (receipt, c) => ({
          score: 10 * Number(receipt.output === c.expected),
          violation: 0,
          feedback: `wanted ${String(c.expected)} for ${(c.input as { topic: string }).topic}`,
        }),
        reflect: async (input) => {
          inputs.push(input);
          return opts.reflect(input);
        },
      });
      expect(inputs[0]!.failures.map((f) => f.caseId)).toEqual(["train-yes-0", "train-yes-1"]);
      expect(inputs[0]!.failures[0]!.feedback).toBe("wanted handled for alpha");
      expect(inputs[0]!.parentScores).toEqual({ trainMean: 5, validationMean: 5, violations: 0 });
      expect([...runnerKeys].sort()).toEqual(["id", "input", "split"]);
    });
  });

  it("recovers from transient failures with repeatable recovery", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      let runFailures = 1;
      let reflectFailures = 1;
      const opts = baseOptions(storage, { rounds: 1 });
      const result = await optimizeReflective({
        ...opts,
        run: async (...args) => {
          if (runFailures-- > 0) throw new Error("transient network error");
          return opts.run(...args);
        },
        reflect: async (...args) => {
          if (reflectFailures-- > 0) throw new Error("transient reflector error");
          return opts.reflect(...args);
        },
      });
      expect(result.history[0]!.accepted).toBe(true);
    });
  });

  it("stops before an unaffordable round and validates budgets upfront", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const perRound = 0.25 + cases().length * 0.5;
      const result = await optimizeReflective({
        ...baseOptions(storage),
        rounds: 5,
        costLimit: 0.5,
        reflectionCostLimit: 0.25,
        budget: { cost: cases().length * 0.5 + perRound },
        run: async (prompt, c, ctx) => ({ ...(await baseOptions(storage).run(prompt, c, ctx)), cost: 0.5 }),
      });
      expect(result.roundsCompleted).toBe(1);
      expect(result.stopReason).toMatch("Budget exhausted");
      await expect(optimizeReflective({
        ...baseOptions(storage, { id: "other" }),
        costLimit: 1,
        budget: { cost: 0 },
      })).rejects.toThrow("Budget cannot reserve one round");
    });
  });

  it("audits on held-out cases without leaking them to the reflector", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const seenInputs: unknown[] = [];
      const result = await optimizeReflective({
        ...baseOptions(storage),
        rounds: 2,
        reflect: async (input) => {
          seenInputs.push(input.failures.map((f) => f.caseId));
          return baseOptions(storage).reflect(input);
        },
        finalCases: [
          { id: "final-1", input: { topic: "alpha" }, expected: "handled" },
          { id: "final-2", input: { topic: "other-final" }, expected: "missed" },
        ],
      });
      expect(result.finalAudit).toMatchObject({ cases: 2, test: null });
      expect(result.finalAudit!.championMean).toBe(1);
      expect(JSON.stringify(seenInputs)).not.toContain("final-");
      expect(JSON.stringify(result)).not.toContain("other-final");
    });
  });

  it("tests the final gain on held-out cases, and only when the evidence suffices", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const finalCases = (n: number) => Array.from({ length: n }, (_, i) =>
        ({ id: `final-${i}`, input: { topic: i % 2 ? "alpha" : "beta" }, expected: "handled" }));
      const opts = (id: string, n: number) => ({ ...baseOptions(storage, { id }), rounds: 2, finalCases: finalCases(n),
        finalTest: { scoreRange: 1 } });
      const many = await optimizeReflective(opts("many", 40));
      expect(many.finalAudit).toMatchObject({ baselineMean: 0, championMean: 1 });
      expect(many.finalAudit!.test!.accepted).toBe(true);
      const few = await optimizeReflective(opts("few", 2));
      expect(few.finalAudit!.test!.accepted).toBe(false);
      await expect(optimizeReflective({ ...baseOptions(storage, { id: "no-final" }), finalTest: { scoreRange: 1 } }))
        .rejects.toThrow("finalTest needs finalCases");
    });
  });

  it("fails fast on invalid reflector output and invalid scores", async () => {
    await withDir(async (dir) => {
      await expect(optimizeReflective({
        ...baseOptions(join(dir, "a.db"), { id: "bad-text" }),
        rounds: 1,
        reflect: async () => ({ text: "   ", cost: 0 }),
      })).rejects.toThrow("Round 0 proposal failed");
      await expect(optimizeReflective({
        ...baseOptions(join(dir, "b.db"), { id: "bad-score" }),
        rounds: 1,
        score: () => ({ score: NaN, violation: 0 }),
      })).rejects.toThrow("Seed evaluation failed");
    });
  });

  it("validates options and case partitions", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const good = cases();
      await expect(optimizeReflective({ ...baseOptions(storage), initialPrompt: "  " })).rejects.toThrow("initialPrompt");
      await expect(optimizeReflective({ ...baseOptions(storage), cases: [...good, { ...good[0]! }] })).rejects.toThrow("Duplicate case id");
      await expect(optimizeReflective({ ...baseOptions(storage), cases: good.filter((c) => c.split === "train") })).rejects.toThrow("train and one validation");
      await expect(optimizeReflective({ ...baseOptions(storage),
        finalCases: [{ id: good[0]!.id, input: {}, expected: {} }] })).rejects.toThrow("disjoint");
      await expect(optimizeReflective({ ...baseOptions(storage), rounds: 101 })).rejects.toThrow("rounds");
      await expect(optimizeReflective({ ...baseOptions(storage), maxFailures: 0 })).rejects.toThrow("maxFailures");
    });
  });

  it("keeps credentials out of the journaled result", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const secret = "sk-secret-only-in-closure";
      const result = await optimizeReflective({
        ...baseOptions(storage),
        rounds: 1,
        run: async (prompt, c, ctx) => {
          void secret;
          return baseOptions(storage).run(prompt, c, ctx);
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });
});

describe("multi-component systems and merge", () => {
  // Components `a` and `b` each list handled topics; a word "na"/"nb" wrongly handles one negative case.
  const componentCases = (): ReflectiveCase[] => {
    const out: ReflectiveCase[] = [];
    for (const split of ["train", "validation"] as const) {
      for (const [id, topic] of [["alpha-1", "alpha"], ["alpha-2", "alpha"], ["beta-1", "beta"], ["beta-2", "beta"], ["na", "na"], ["nb", "nb"]]) {
        out.push({ id: `${split}-${id}`, split, input: { topic }, expected: topic.startsWith("n") ? "missed" : "handled" });
      }
    }
    return out;
  };
  const componentOptions = (storage: string, extra: Partial<ReflectiveOptions<PromptSet>> = {}): ReflectiveOptions<PromptSet> => ({
    id: "components-v1",
    storage,
    implementation: { task: "component-fixture-v1", reflector: "stub-component-v1" },
    initialPrompt: { a: "x", b: "y" },
    objective: "Handle alpha and beta topics; miss everything else.",
    cases: componentCases(),
    run: async (prompts, c) => {
      const topic = (c.input as { topic: string }).topic;
      const has = (text: string) => text.split(" ").includes(topic);
      return { output: has(prompts.a!) || has(prompts.b!) ? "handled" : "missed", cost: 0 };
    },
    score: (receipt, c) => ({ score: Number(receipt.output === c.expected), violation: 0 }),
    reflect: async ({ component, parentPrompt }) =>
      ({ text: component === "a" ? `${parentPrompt} alpha na` : `${parentPrompt} beta nb`, cost: 0 }),
    recovery: "repeatable",
    parentStrategy: "pareto",
    seed: 1,
    rounds: 3,
    ...extra,
  });

  it("rewrites one component per round, round-robin, and passes the whole system to run and reflect", async () => {
    await withDir(async (dir) => {
      const inputs: Parameters<ReflectiveOptions<PromptSet>["reflect"]>[0][] = [];
      const opts = componentOptions(join(dir, "learning.db"), { parentStrategy: "champion", rounds: 2 });
      const result = await optimizeReflective({ ...opts, reflect: async (input) => { inputs.push(input); return opts.reflect(input); } });
      expect(inputs.map((i) => i.component)).toEqual(["a", "b"]);
      expect(inputs[1]!.parentSystem).toEqual({ a: "x alpha na", b: "y" });
      expect(inputs[1]!.parentPrompt).toBe("y");
      expect(result.history.map((h) => [h.kind, h.component, h.accepted])).toEqual([["reflect", "a", true], ["reflect", "b", true]]);
      expect(result.champion).toEqual({ a: "x alpha na", b: "y beta nb" });
    });
  });

  it("merges sibling improvements to different components from a common ancestor", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const without = await optimizeReflective(componentOptions(storage, { id: "no-merge" }));
      expect(without.merges).toBe(0);
      expect(without.history.every((h) => h.kind === "reflect")).toBe(true);

      const reflect = vi.fn(componentOptions(storage).reflect);
      const opts = componentOptions(storage, { id: "merge", maxMerges: 1, reflect });
      const result = await optimizeReflective(opts);
      // Round 1 improves `b` from the initial prompt: it only ties champion `a`, so it stays a frontier sibling.
      expect(result.history[1]).toMatchObject({ component: "b", parentPrompt: { a: "x", b: "y" }, evaluated: true, accepted: false });
      expect(result.history[2]).toMatchObject({
        kind: "merge", component: null, parentPrompt: { a: "x alpha na", b: "y" }, mergeParent: { a: "x", b: "y beta nb" },
        candidatePrompt: { a: "x alpha na", b: "y beta nb" }, reflectionCost: 0, evaluated: true, accepted: true,
      });
      expect(result.champion).toEqual({ a: "x alpha na", b: "y beta nb" });
      expect(result.merges).toBe(1);
      expect(result.reflectionCalls).toBe(2);
      expect(reflect).toHaveBeenCalledTimes(2);
      // Merges replay from journaled outcomes like everything else.
      expect(await optimizeReflective(opts)).toEqual(result);
      expect(reflect).toHaveBeenCalledTimes(2);
    });
  });

  it("validates component records", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      await expect(optimizeReflective(componentOptions(storage, { initialPrompt: {} }))).rejects.toThrow("initialPrompt");
      await expect(optimizeReflective(componentOptions(storage, { initialPrompt: { a: "x", b: " " } }))).rejects.toThrow("initialPrompt");
      await expect(optimizeReflective(componentOptions(storage, { maxMerges: -1 }))).rejects.toThrow("maxMerges");
    });
  });
});

describe("reflective helpers", () => {
  it("builds a reflection prompt from train failures with evaluator feedback", () => {
    const text = buildReflectionPrompt("Handle topics", "base.", [
      { caseId: "train-1", input: "a", expected: "x", actual: "y", trace: "thought", feedback: "label must be x" },
    ], { trainMean: 0.5, validationMean: 0.5, violations: 0 });
    expect(text).toContain("train-1");
    expect(text).toContain("Handle topics");
    expect(text).toContain("base.");
    expect(text).toContain("Evaluator feedback: label must be x");
    const scores = { trainMean: 0, validationMean: 0, violations: 0 };
    const multi = buildReflectionPrompt("Goal", "fmt v1", [], scores, { component: "format", system: { format: "fmt v1", system: "sys v1" } });
    expect(multi).toContain('rewrite only "format"');
    expect(multi).toContain("sys v1");
    expect(multi).toContain('improved text of the "format" component');
    expect(buildReflectionPrompt("Goal", "p", [], scores, { component: "prompt", system: { prompt: "p" } })).toContain("Current system prompt:");
  });

  it("keeps per-case Pareto winners and samples parents by wins, deterministically", () => {
    const valCases: ReflectiveCase[] = ["v1", "v2", "v3"].map((id) => ({ id, split: "validation", input: id, expected: 1 }));
    const outcomes = (...scores: number[]) => scores.map((score, i) => ({ caseId: `v${i + 1}`, score, violation: 0 }));
    const frontier = paretoFrontier([
      { prompt: "a", outcomes: outcomes(1, 1, 0) },
      { prompt: "b", outcomes: outcomes(0, 0, 1) },
      { prompt: "c", outcomes: outcomes(0.6, 0.6, 0.6) }, // best mean, wins no case
      { prompt: "d", outcomes: outcomes(1, 0, 0) },       // dominated by a
    ], valCases);
    expect(frontier.map((e) => [e.prompt, e.wins])).toEqual([["a", 2], ["b", 1]]);
    const picks = Array.from({ length: 300 }, (_, round) => selectParent(frontier, 7, round));
    expect(picks).toEqual(Array.from({ length: 300 }, (_, round) => selectParent(frontier, 7, round)));
    const share = picks.filter((p) => p === "a").length / picks.length;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.8);
  });
});
