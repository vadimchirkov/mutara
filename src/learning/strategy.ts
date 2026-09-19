// Bounded, declarative search. Proposers see versions,
// never the world's recipe table. Every candidate has an immutable identity.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pick, type Policy, type GameView } from "../game/policies.js";
import { rng } from "../game/table.js";
import type { Memory } from "../memory.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
// Store these bytes in the experiment journal, not just an unrecoverable hash.
export const implementation = {
  files: Object.fromEntries(["learning/strategy.ts", "learning/experiment.ts", "learning/alchemy.ts", "learning/bench.ts", "learning/statistics.ts",
    "game/policies.ts", "game/engine.ts", "game/table.ts", "memory.ts", "provenance.ts"].map((path) =>
    [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")])),
};
export const implementationId = digest(implementation);

export interface Weights { productivity: number; novelty: number; exploration: number }
interface FeatureContext { v: GameView; uses: Map<string, number>; wins: (e: string) => number; scale: number }
// Registry order controls introduction: two features initially, one more every
// four proposals. A new entry automatically joins both search methods.
export const FEATURES = {
  productivity: (c: FeatureContext, e: string) => c.wins(e) / c.scale,
  novelty: (c: FeatureContext, e: string) => 1 / (1 + (c.uses.get(e) ?? 0)),
  recency: (c: FeatureContext, e: string) => 1 / (1 + c.v.t - (c.v.discoveredAt.get(e) ?? 0)),
  successRate: (c: FeatureContext, e: string) => (c.v.wins.get(e) ?? 0) / (1 + (c.uses.get(e) ?? 0)),
  // Randomness is sampled per pair, after deterministic ingredient scores.
  exploration: (_c: FeatureContext, _e: string) => 0,
};
export const CONDITIONS = {
  always: (_v: GameView) => true,
  early: (v: GameView) => v.t < 40,
  late: (v: GameView) => v.t >= 40,
  stalled: (v: GameView) => v.t - Math.max(0, ...v.discoveredAt.values()) >= 10,
};
export interface Component { feature: keyof typeof FEATURES; weight: number; when: keyof typeof CONDITIONS }
export interface StrategyVersion {
  id: string;
  parentId: string | null;
  implementationId: string;
  weights: Weights;
  components: Component[];
}
export const INITIAL_WEIGHTS: Weights = { productivity: 1, novelty: 0, exploration: 0 };

export function strategyVersion(weights: Weights, parentId: string | null = null, components: Component[] = []): StrategyVersion {
  const ordered = { productivity: weights.productivity, novelty: weights.novelty, exploration: weights.exploration };
  if (Object.keys(weights).length !== 3 || Object.values(ordered).some((n) => !Number.isFinite(n) || n < 0 || n > 4)) {
    throw new Error("Strategy weights must be three finite numbers in [0, 4]");
  }
  if (!Array.isArray(components) || components.length > Object.keys(FEATURES).length ||
      components.some((c) => !c || Object.keys(c).length !== 3 || !Object.hasOwn(FEATURES, c.feature) ||
        !Object.hasOwn(CONDITIONS, c.when) || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > 4) ||
      new Set(components.map((c) => c.feature)).size !== components.length) throw new Error("Invalid strategy components");
  const terms = components.map((c) => Object.freeze({ feature: c.feature, weight: c.weight, when: c.when }))
    .sort((a, b) => a.feature.localeCompare(b.feature));
  Object.freeze(terms);
  const content = { parentId, implementationId, weights: ordered, components: terms };
  return Object.freeze({ id: digest(content), ...content, weights: Object.freeze(ordered) });
}

export function weightedPolicy(version: StrategyVersion): Policy {
  if (version.implementationId !== implementationId || strategyVersion(version.weights, version.parentId, version.components).id !== version.id) {
    throw new Error("Strategy artifact changed or uses a different implementation");
  }
  const w = { ...version.weights };
  const components = version.components.map((c) => ({ ...c }));
  const policy: Policy = (v, rand) => {
    const wins = (e: string) => (v.wins.get(e) ?? 0) + (v.memory?.wins.get(e) ?? 0);
    const scale = Math.max(1, ...v.known.map(wins));
    const uses = new Map<string, number>();
    if (w.novelty || components.length) for (const key of v.tried) {
      for (const e of key.split(" + ")) uses.set(e, (uses.get(e) ?? 0) + 1);
    }
    const context = { v, uses, wins, scale };
    const active = components.filter((c) => CONDITIONS[c.when](v));
    const scores = new Map(v.known.map((e) => [e, active.reduce((sum, c) => sum + c.weight * FEATURES[c.feature](context, e), 0)]));
    const exploration = w.exploration + (active.find((c) => c.feature === "exploration")?.weight ?? 0);
    return pick(v, rand, (a, b) =>
      w.productivity * (wins(a) + wins(b)) / scale +
      w.novelty * (1 / (1 + (uses.get(a) ?? 0)) + 1 / (1 + (uses.get(b) ?? 0))) +
      (scores.get(a) ?? 0) + (scores.get(b) ?? 0) +
      (exploration ? exploration * rand() : 0));
  };
  return Object.assign(policy, { versionId: version.id });
}

export type SearchMethod = "adaptive" | "random" | "components" | "componentsRandom";
export type Proposer = (champion: StrategyVersion, round: number, seed: number) => StrategyVersion;
const LEVELS = [0, 0.25, 0.5, 1, 2, 4];
const AXES = ["novelty", "exploration", "productivity"] as const;
export const availableFeatures = (round: number) =>
  (Object.keys(FEATURES) as Component["feature"][]).slice(0, 2 + Math.floor(round / 4));
export const availableConditions = (round: number): Component["when"][] => round < 8 ? ["always"] : ["always", "early", "late", "stalled"];
const ZERO_WEIGHTS: Weights = { productivity: 0, novelty: 0, exploration: 0 };

function proposeComponents(champion: StrategyVersion, round: number, seed: number, independent: boolean) {
  const random = rng(seed + round * 0x9e3779b9);
  const draw = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const features = availableFeatures(round), conditions = availableConditions(round);
  const terms = independent ? [] : champion.components.map((c) => ({ ...c }));
  if (!independent) for (const feature of AXES) {
    if (champion.weights[feature]) terms.push({ feature, weight: champion.weights[feature], when: "always" });
  }
  if (independent) {
    for (const feature of features) {
      const weight = draw(LEVELS);
      if (weight) terms.push({ feature, weight, when: draw(conditions) });
    }
  } else {
    // ponytail: incumbent-only search can stall at local optima; a population
    // is warranted only if this equal-budget benchmark demonstrates the need.
    const mutate = () => {
      const feature = draw(features);
      const index = terms.findIndex((c) => c.feature === feature);
      const old = terms[index];
      if (old && round % 3 === 2 && conditions.length > 1) {
        terms[index] = { ...old, when: draw(conditions.filter((when) => when !== old.when)) };
      } else {
        const weight = draw(LEVELS.filter((w) => w !== (old?.weight ?? 0)));
        if (index >= 0) terms.splice(index, 1);
        if (weight) terms.push({ feature, weight, when: old?.when ?? "always" });
      }
    };
    mutate();
    if (round % 4 === 3) mutate(); // compositions can cross a one-change plateau
  }
  return strategyVersion(ZERO_WEIGHTS, champion.id, terms);
}

export const proposers: Record<SearchMethod, Proposer> = {
  components: (champion, round, seed) => proposeComponents(champion, round, seed, false),
  componentsRandom: (champion, round, seed) => proposeComponents(champion, round, seed, true),
  adaptive(champion, round, seed) {
    // Coordinate mutation around the accepted strategy; acceptance determines
    // the starting point of the next proposal. No model call or recipe access.
    const random = rng(seed + round * 0x9e3779b9);
    const axis = AXES[round % AXES.length];
    const alternatives = LEVELS.filter((n) => n !== champion.weights[axis]);
    return strategyVersion({ ...champion.weights, [axis]: alternatives[Math.floor(random() * alternatives.length)] }, champion.id);
  },
  random(champion, round, seed) {
    const random = rng(seed + round * 0x9e3779b9);
    const draw = () => LEVELS[Math.floor(random() * LEVELS.length)];
    // Same version lineage, but parameters are independent of the incumbent.
    return strategyVersion({ productivity: draw(), novelty: draw(), exploration: draw() }, champion.id);
  },
};

export interface MemorySnapshot { deadPairs: string[]; productive: string[]; wins: [string, number][] }
export const snapshotMemory = (m: Memory): MemorySnapshot => ({
  deadPairs: [...m.deadPairs].sort(), productive: [...m.productive].sort(),
  wins: [...m.wins].sort(([a], [b]) => a.localeCompare(b)),
});
export function restoreMemory(m: MemorySnapshot): Memory {
  if (!Array.isArray(m.deadPairs) || !Array.isArray(m.productive) || !Array.isArray(m.wins) ||
      [...m.deadPairs, ...m.productive].some((p) => typeof p !== "string") ||
      m.wins.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
        !Number.isSafeInteger(entry[1]) || entry[1] < 0) ||
      new Set(m.wins.map(([key]) => key)).size !== m.wins.length ||
      m.deadPairs.some((key) => m.productive.includes(key))) throw new Error("Invalid memory snapshot");
  return { deadPairs: new Set(m.deadPairs), productive: new Set(m.productive), wins: new Map(m.wins) };
}
