import { expect, it } from "vitest";
// @ts-ignore — standalone example.
import { payoff, exploitability, decide, N } from "../examples/league/rps.mjs";
// @ts-ignore — standalone example.
import { holmRejects } from "../examples/connect4/league-paired.mjs";
// @ts-ignore — standalone example.
import { assign, decideCandidate } from "../examples/connect4/league.mjs";
// @ts-ignore — standalone example.
import { grade, ATTACKS, NORMAL } from "../examples/injection/data.mjs";
// @ts-ignore — standalone example.
import { payoff as blotto, exploitability as blottoExploitability } from "../examples/blotto/blotto.mjs";
// @ts-ignore — standalone example.
import { regretMatching, bestResponse, weightedExploitability } from "../examples/blotto/psro.mjs";

it("scores rock-paper-scissors exactly", () => {
  const rock = [N, 0, 0], paper = [0, N, 0], uniform = [4, 4, 4];
  expect(payoff(paper, rock)).toBe(1);
  expect(payoff(rock, paper)).toBe(-1);
  expect(payoff(uniform, rock)).toBe(0);
  expect(exploitability(uniform)).toBe(0);
  expect(exploitability(rock)).toBe(1);
});

it("league rule blocks a gain that regresses on one member", () => {
  const plan = { rule: "league", margin: 0.05 };
  expect(decide({ candidate: [0.5, 0.2], champion: [0.1, 0.1] }, plan).accepted).toBe(true);
  expect(decide({ candidate: [0.9, 0.0], champion: [0.1, 0.1] }, plan).accepted).toBe(false);
  expect(decide({ candidate: [0.2], champion: [0.1] }, { rule: "last" }).accepted).toBe(true);
});

it("Holm flags a member regression only after correction", () => {
  expect(holmRejects([0.04, 0.5], 0.05)).toBe(false);
  expect(holmRejects([0.02, 0.5], 0.05)).toBe(true);
  expect(holmRejects([], 0.05)).toBe(false);
});

it("injection grading ranks a breach below a missing code", () => {
  const attack = ATTACKS[0].expected, normal = NORMAL[0].expected;
  expect(grade(`ok ${attack.ref} ${attack.canary.toLowerCase()}`, attack)).toMatchObject({ score: 0, violation: 1 });
  expect(grade("summary", normal)).toMatchObject({ score: 0.5, violation: 0 });
  expect(grade(`summary ${normal.ref}`, normal)).toMatchObject({ score: 1, violation: 0 });
  expect(new Set([...ATTACKS, ...NORMAL].map((c) => c.input.text)).size).toBe(220);
});

it("Connect-4 league splits seed pairs evenly and rejects a member regression", () => {
  const seeds = Array.from({ length: 64 }, (_, i) => i);
  const who = assign(seeds, 3);
  expect([0, 1, 2].map((j) => who.filter((x: number) => x === j).length)).toEqual([24, 20, 20]);
  expect(who.every((x: number, i: number) => i % 2 === 0 || x === who[i - 1])).toBe(true);
  const plan = { trainingSeeds: [1, 2, 3, 4], validationSeeds: [5, 6, 7, 8], minimumGain: 0.03, margin: 0.1 };
  const games = (seeds: number[], scores: number[]) => seeds.map((seed, i) => ({ seed, opponent: i < 2 ? "a" : "b", score: scores[i] }));
  const ok = { candidateTraining: games(plan.trainingSeeds, [1, 1, 0.5, 0.5]), candidateValidation: games(plan.validationSeeds, [1, 0.5, 0.5, 0.5]) };
  expect(decideCandidate(ok, plan).accepted).toBe(true);
  const regress = { ...ok, candidateValidation: games(plan.validationSeeds, [1, 1, 0.5, 0]) };
  expect(decideCandidate(regress, plan).accepted).toBe(false);
});

it("scores Colonel Blotto exactly", () => {
  const mix = [[8, 4, 4, 2, 2], [4, 4, 4, 4, 4], [0, 5, 5, 5, 5], [10, 10, 0, 0, 0]];
  expect(blotto(mix, mix)).toBe(0);
  expect(blotto([[5, 5, 5, 5, 0]], [[4, 4, 4, 4, 4]])).toBe(1);
  expect(blotto([[4, 4, 4, 4, 4]], [[5, 5, 5, 5, 0]])).toBe(-1);
  // Against (4,4,4,4,4): 5 on four fields wins 4 of 5, so the best response scores 1.
  expect(blottoExploitability([[4, 4, 4, 4, 4]])).toBe(1);
  expect(blottoExploitability([[20, 0, 0, 0, 0]])).toBe(1);
});

it("PSRO pieces: regret matching, best response, weighted exploitability", () => {
  const rps = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]];
  for (const w of regretMatching(rps)) expect(Math.abs(w - 1 / 3)).toBeLessThan(0.02);
  // Unequal RPS (wins pay 2 on one edge) still converges near its equilibrium mix.
  const skew = [[0, -1, 2], [1, 0, -1], [-2, 1, 0]];
  const w = regretMatching(skew);
  for (let i = 0; i < 3; i++) expect(Math.abs(skew[i].reduce((a, m, j) => a + m * w[j], 0))).toBeLessThan(0.02);
  expect(bestResponse([[20, 0, 0, 0, 0]], [1]).value).toBe(1);
  const mix = [[8, 4, 4, 2, 2], [4, 4, 4, 4, 4], [0, 5, 5, 5, 5], [10, 10, 0, 0, 0]];
  expect(weightedExploitability(mix, [0.25, 0.25, 0.25, 0.25])).toBeCloseTo(blottoExploitability(mix), 12);
});
