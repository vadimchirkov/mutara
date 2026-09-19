// The Q4 control only means anything if the control itself is right: a wrong
// GroundTruth evaluator would produce a confident correlation against nothing.

import { describe, expect, it } from "vitest";
import { loadTable } from "../src/game/table.js";
import { correlation, productive, plausible, type Situation } from "../src/q4.js";

const table = loadTable();

const situation = (known: string[], wins: Record<string, number> = {}): string =>
  JSON.stringify({ seed: 1, t: 0, known, tried: [], discoveredAt: {}, wins } satisfies Situation);

const score = async (ev: { evaluate: (i: never) => Promise<{ score: number }> }, response: string, context: string) =>
  (await ev.evaluate({ question: "", response, context } as never)).score;

describe("GroundTruth evaluator", () => {
  const truth = productive(table);

  it("scores a productive pair 1", async () => {
    // water + fire -> steam, and steam is not known yet.
    expect(await score(truth, "fire + water", situation(["water", "fire"]))).toBe(1);
  });

  it("scores a pair whose result is already known 0", async () => {
    expect(await score(truth, "fire + water", situation(["water", "fire", "steam"]))).toBe(0);
  });

  it("scores a pair that produces nothing 0", async () => {
    expect(table.combine("water", "steam")).toEqual([]);
    expect(await score(truth, "steam + water", situation(["water", "steam"]))).toBe(0);
  });

  it("scores an unparseable answer 0 rather than throwing", async () => {
    expect(await score(truth, "", situation(["water", "fire"]))).toBe(0);
    expect(await score(truth, "fire + water + earth", situation(["water", "fire"]))).toBe(0);
    expect(await score(truth, "fire + water", situation(["water"]))).toBe(0);
    const repeated = JSON.parse(situation(["water", "fire"]));
    repeated.tried = ["fire + water"];
    expect(await score(truth, "fire + water", JSON.stringify(repeated))).toBe(0);
  });
});

describe("PriorPlausible evaluator", () => {
  const judge = plausible();

  it("rewards pairs whose elements have produced before", async () => {
    const ctx = situation(["water", "fire"], { water: 2, fire: 1 });
    expect(await score(judge, "fire + water", ctx)).toBe(1);
    expect(await score(judge, "fire + earth", ctx)).toBe(0.5);
  });

  it("never reads the recipe table", async () => {
    // A pair that is objectively dead still scores well if both elements have
    // won before — which is exactly why it has to be checked against truth.
    const ctx = situation(["water", "steam"], { water: 3, steam: 3 });
    expect(table.combine("water", "steam")).toEqual([]);
    expect(await score(judge, "steam + water", ctx)).toBe(1);
  });
});

describe("correlation", () => {
  it("is 1 for identical series and -1 for inverted ones", () => {
    expect(correlation([0, 1, 0, 1], [0, 1, 0, 1])).toBeCloseTo(1);
    expect(correlation([0, 1, 0, 1], [1, 0, 1, 0])).toBeCloseTo(-1);
  });

  it("is 0 when a series is constant, rather than NaN", () => {
    expect(correlation([1, 1, 1, 1], [0, 1, 0, 1])).toBe(0);
  });
});
