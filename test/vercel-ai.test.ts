import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, type GateCase } from "../src/gate.js";
import { optimizeReflective } from "../src/reflective.js";
import { generateText, isStepCount, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

// Asset is JS with JSDoc; import via relative path (vitest handles ESM JS).
// @ts-expect-error - JS asset without types
import { createTextRunner, exactScore, jsonFieldsScore, objectScore, createObjectRunner, toolCallsOf, calledTool, toolSequence, usageCost, usdCost } from "../skills/mutara/assets/vercel-ai.mjs";

function withDir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "mutara-vercel-ai-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const stubGenerateText = async ({ system, prompt }: { system: string; prompt: string }) => {
  const m = String(prompt).match(/topic:([a-z-]+)/);
  const topic = m?.[1] ?? "";
  const output = topic.startsWith("other") ? "missed" : String(system).includes(topic) && topic ? "handled" : "missed";
  return { text: output, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
};

describe("vercel-ai template", () => {
  it("accounts usage cost in tokens or USD and rejects missing usage", () => {
    expect(usageCost({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })).toBe(15);
    expect(usageCost({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }, 2)).toBeCloseTo(30 / 1e6);
    expect(() => usageCost({})).toThrow();
  });

  it("wraps generateText into a Mutara runner with validation", async () => {
    const generateText = vi.fn(stubGenerateText);
    const run = createTextRunner({ generateText, model: "stub", params: { temperature: 0 } });
    const receipt = await run("base alpha", { input: { text: "topic:alpha x" } });
    expect(receipt).toMatchObject({ output: "handled", cost: 15 });
    expect(typeof receipt.trace).toBe("string");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: "base alpha", prompt: "topic:alpha x", temperature: 0 }),
    );
    await expect(run("", { input: { text: "x" } })).rejects.toThrow();
    await expect(run("s", { input: { text: "" } })).rejects.toThrow();
    const bad = createTextRunner({ generateText: async () => ({ text: 42 }), model: "stub" });
    await expect(bad("s", { input: { text: "topic:alpha" } })).rejects.toThrow();
  });

  it("prices split input/output usage in USD", () => {
    const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
    expect(usdCost(usage, { mini: { input: 1, output: 2 } }, "mini")).toBeCloseTo(2 / 1000);
    expect(usdCost(usage, { mini: { blended: 3 } }, "mini")).toBeCloseTo(1500 * 3 / 1e6);
    expect(() => usdCost(usage, {}, "mini")).toThrow();
    expect(() => usdCost({ totalTokens: 10 }, { mini: { input: 1, output: 2 } }, "mini")).toThrow();
  });

  it("runs generateObject and grades schema failures as violations", async () => {
    const ok = createObjectRunner({
      generateObject: async () => ({ object: { a: "1" }, usage: { totalTokens: 7 } }),
      model: "stub",
    });
    const receipt = await ok("sys", { input: { text: "hi" } });
    expect(receipt.output).toEqual({ a: "1" });
    expect(objectScore(receipt.output, { a: "1" })).toMatchObject({ score: 1, violation: 0 });
    expect(objectScore(null, { a: "1" }).violation).toBe(1);

    const failing = createObjectRunner({
      generateObject: async () => {
        throw Object.assign(new Error("no object"), { name: "NoObjectGeneratedError", usage: { totalTokens: 9 } });
      },
      model: "stub",
    });
    const bad = await failing("sys", { input: { text: "hi" } });
    expect(bad.output).toBeNull();
    expect(bad.cost).toBe(9);
    expect(objectScore(bad.output, { a: "1" })).toMatchObject({ score: 0, violation: 1 });

    const transport = createObjectRunner({
      generateObject: async () => { throw new Error("boom"); },
      model: "stub",
    });
    await expect(transport("sys", { input: { text: "hi" } })).rejects.toThrow("boom");
  });

  it("checks tool selection, args and order", () => {
    const calls = toolCallsOf({
      steps: [{ toolCalls: [{ toolName: "get_weather", args: { city: "Paris" } }] }, { toolCalls: [] }],
      toolCalls: undefined,
    });
    expect(calls).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
    expect(calledTool(calls, "get_weather").score).toBe(1);
    expect(calledTool(calls, "get_time").score).toBe(0);
    expect(calledTool(calls, "get_weather", { args: { city: "Paris" } }).score).toBe(1);
    expect(calledTool(calls, "get_weather", { args: { city: "Berlin" } }).score).toBe(0);
    expect(toolSequence([...calls, { name: "get_time", args: {} }], ["get_weather", "get_time"]).score).toBe(1);
    expect(toolSequence(calls, ["get_time", "get_weather"]).score).toBe(0);
    expect(() => toolCallsOf({ toolCalls: [{ args: {} }] })).toThrow();
  });

  it("reads AI SDK 5 results: calls from all steps, input/output token names", () => {
    // v5 with an executed tool: the last step answers in text, so result.toolCalls is empty.
    const result = {
      text: "Sunny",
      toolCalls: [],
      steps: [{ toolCalls: [{ toolName: "get_weather", input: { city: "Paris" } }] }, { toolCalls: [] }],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
    expect(toolCallsOf(result)).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
    expect(usageCost(result.usage)).toBe(120);
    expect(usdCost(result.usage, { m: { input: 1, output: 10 } }, "m")).toBeCloseTo(0.0003);
  });

  it("reads a real `ai` generateText result from a multi-step tool agent", async () => {
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
    const finish = (unified: "tool-calls" | "stop") => ({ unified, raw: undefined });
    const model = new MockLanguageModelV4({
      modelId: "mock-model",
      doGenerate: [
        { content: [{ type: "tool-call", toolCallId: "1", toolName: "get_weather", input: '{"city":"Paris"}' }], finishReason: finish("tool-calls"), usage, warnings: [] },
        { content: [{ type: "text", text: "Sunny" }], finishReason: finish("stop"), usage, warnings: [] },
      ],
    });
    const result = await generateText({
      model, system: "Use get_weather.", prompt: "weather in Paris", stopWhen: isStepCount(2),
      tools: { get_weather: tool({ description: "Weather", inputSchema: z.object({ city: z.string() }), execute: async () => "sunny" }) },
    });
    expect(toolCallsOf(result)).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
    expect(usageCost(result.usage)).toBe(30);
    expect(usdCost(result.usage, { "mock-model": { input: 1, output: 10 } }, model.modelId)).toBeCloseTo(0.00012);
  });
  it("scores exact and JSON fields, flagging non-JSON as violation", () => {
    expect(exactScore("a", "a").score).toBe(1);
    expect(exactScore("a", "b").feedback).toMatch("expected");
    expect(jsonFieldsScore('{"a":"1","b":"2"}', { a: "1", b: "2" })).toMatchObject({ score: 1, violation: 0 });
    expect(jsonFieldsScore("nope", { a: "1" }).violation).toBe(1);
    expect(jsonFieldsScore('{"a":"1","b":"x"}', { a: "1", b: "2" }).score).toBe(0.5);
  });

  it("tunes a stub prompt and gates the champion on fresh cases with resume", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      const topics = ["alpha", "beta"];
      const cases: { id: string; split: "train" | "validation"; input: { text: string }; expected: string }[] = [];
      for (const split of ["train", "validation"] as const) {
        topics.forEach((topic, i) => {
          cases.push({ id: `${split}-yes-${i}`, split, input: { text: `topic:${topic} ${split}-${i}` }, expected: "handled" });
          cases.push({ id: `${split}-no-${i}`, split, input: { text: `topic:other-${split}-${i}` }, expected: "missed" });
        });
      }
      const generateText = vi.fn(stubGenerateText);
      const run = createTextRunner({ generateText, model: "stub", params: { temperature: 0 } });
      const tuned = await optimizeReflective({
        id: "vercel-ai-v1",
        storage,
        implementation: { task: "vercel-ai-test-v1", reflector: "stub", evaluator: "exact-v1" },
        initialPrompt: "base prompt.",
        objective: "Handle alpha and beta; miss everything else.",
        cases,
        run,
        score: (receipt, c) => exactScore(receipt.output, (c as { expected: string }).expected),
        reflect: async ({ parentPrompt, failures }) => {
          const missing = topics.find((t) => !parentPrompt.includes(t));
          void failures;
          return { text: missing ? `${parentPrompt} ${missing}` : `${parentPrompt}!`, cost: 0 };
        },
        recovery: "repeatable",
        rounds: 3,
        costLimit: 1000,
        reflectionCostLimit: 0,
        budget: { cost: 1_000_000 },
      });
      expect(tuned.champion).toBe("base prompt. alpha beta");

      const fresh = Array.from({ length: 20 }, (_, i) => [
        { id: `f-yes-${i}`, input: { text: `topic:alpha fresh-${i}` }, expected: "handled" },
        { id: `f-no-${i}`, input: { text: `topic:other-fresh-${i}` }, expected: "missed" },
      ]).flat();
      const wrap = (system: string) => {
        const r = createTextRunner({ generateText, model: "stub", params: { temperature: 0 } });
        return (c: GateCase) => r(system, { input: c.input });
      };
      const opts = {
        id: "vercel-ai-gate-v1",
        storage,
        implementation: { task: "vercel-ai-gate-v1" },
        cases: fresh,
        baseline: wrap("base prompt."),
        candidate: wrap(tuned.champion),
        score: (output: unknown, c: GateCase) => exactScore(output, (c as unknown as { expected: string }).expected),
        scoreRange: 1,
        recovery: "repeatable" as const,
      };
      const first = await gate(opts);
      expect(first.verdict).toBe("promote");
      const calls = generateText.mock.calls.length;
      const second = await gate(opts);
      expect(second).toEqual(first);
      expect(generateText.mock.calls.length).toBe(calls);
    });
  });

  it("rejects a router candidate that adds false cancellations", async () => {
    await withDir(async (dir) => {
      const fresh = Array.from({ length: 6 }, (_, i) => ({
        id: `c-${i}`, input: { text: `m-${i}` }, expected: "other",
      }));
      const score = (output: unknown) => ({
        score: Number(output === "other"),
        violation: Number(output === "cancel"),
      });
      const result = await gate({
        id: "vercel-router-violation-v1",
        storage: join(dir, "learning.db"),
        implementation: { task: "vercel-router-violation-v1" },
        cases: fresh,
        baseline: async () => ({ output: "other", cost: 0 }),
        candidate: async (c) => ({ output: c.id === "c-0" ? "cancel" : "other", cost: 0 }),
        score: (output) => score(output),
        scoreRange: 1,
        recovery: "repeatable",
      });
      expect(result.verdict).toBe("reject");
      expect(result.candidate.violations).toBeGreaterThan(result.baseline.violations);
    });
  });

  it("tunes extraction conventions and gates the cost-down arms", async () => {
    await withDir(async (dir) => {
      const storage = join(dir, "learning.db");
      // Extraction: one hidden convention ("UPPER"), learned from feedback.
      const rows = [
        { text: "Paid Persön to Acme Ltd.", expected: { vendor: "ACME" } },
        { text: "Paid Persön to Globex LLC.", expected: { vendor: "GLOBEX" } },
      ];
      const stub = async ({ system, prompt }: { system: string; prompt: string }) => ({
        text: JSON.stringify({
          vendor: String(system).includes("UPPER")
            ? (String(prompt).includes("Acme") ? "ACME" : "GLOBEX")
            : "Acme",
        }),
        usage: { totalTokens: 5 },
      });
      const run = createTextRunner({ generateText: stub, model: "stub", params: {} });
      const tuned = await optimizeReflective({
        id: "vercel-extract-mini-v1",
        storage,
        implementation: { task: "vercel-extract-mini-v1" },
        initialPrompt: "Extract.",
        objective: "Vendor UPPER.",
        cases: [
          { id: "t-0", split: "train", input: { text: rows[0].text }, expected: rows[0].expected },
          { id: "v-0", split: "validation", input: { text: rows[1].text }, expected: rows[1].expected },
        ],
        run,
        score: (receipt, c) => jsonFieldsScore(receipt.output, (c as unknown as { expected: Record<string, string> }).expected),
        reflect: async ({ parentPrompt }) => ({ text: `${parentPrompt} UPPER`, cost: 0 }),
        recovery: "repeatable",
        rounds: 2,
        costLimit: 100,
        budget: { cost: 10_000 },
      });
      expect(tuned.champion).toContain("UPPER");

      // Cost-down arms: untuned cheap is rejected, tuned cheap promotes within margin.
      const byText = new Map(Array.from({ length: 60 }, (_, i) => [`f-${i}`, i % 2 ? "yes" : "no"]));
      const arm = (id: string, system: string, margin: number) => gate({
        id,
        storage,
        implementation: { task: id },
        cases: [...byText].map(([text, expected]) => ({ id: text, input: { text }, expected })),
        baseline: async (c) => ({ output: byText.get((c.input as { text: string }).text), cost: 1 }),
        candidate: async (c) => ({
          output: system.includes("Be precise.") ? byText.get((c.input as { text: string }).text) : "no",
          cost: 1,
        }),
        score: (output, c) => exactScore(output, (c as unknown as { expected: string }).expected),
        scoreRange: 1,
        minimumGain: -margin,
        recovery: "repeatable",
      });
      const naive = await arm("vercel-costdown-naive-v1", "Classify.", 0.25);
      expect(naive.verdict).toBe("reject");
      const optimized = await arm("vercel-costdown-opt-v1", "Classify. Be precise.", 0.25);
      expect(optimized.verdict).toBe("promote");
    });
  });
});
