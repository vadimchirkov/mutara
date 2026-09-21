// The game world: a frozen Little Alchemy 2 recipe table.
//
// Pure and deterministic — `combine` is a lookup, never an effect. The table is
// content-hashed so a journal can pin the exact world a run was played against
// (the F4 lesson from AGENT-JOURNAL-HYPOTHESIS.md, applied here from the start).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const BASE = ["water", "fire", "earth", "air"] as const;

export interface Table {
  /** `sha256:...` over the canonical recipe list. Goes into the journal. */
  hash: string;
  elements: string[];
  combine(a: string, b: string): string[];
}

export const pairKey = (a: string, b: string): string => (a < b ? `${a} + ${b}` : `${b} + ${a}`);

export function loadTable(path = new URL("../../data/cheater_la2.json", import.meta.url)): Table {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    names: Record<string, string>;
    recipes: Array<{ ingredients: number[]; results: number[] }>;
  };
  const names = new Map(Object.entries(raw.names).map(([id, n]) => [Number(id), n]));
  const recipes = new Map<string, string[]>();
  for (const { ingredients, results } of raw.recipes) {
    const [a, b] = ingredients.map((i) => names.get(i)!);
    const key = pairKey(a, b ?? a);
    const out = results.map((i) => names.get(i)!);
    recipes.set(key, [...new Set([...(recipes.get(key) ?? []), ...out])]);
  }
  const canonical = [...recipes.entries()]
    .map(([k, v]) => `${k}=${[...v].sort().join(",")}`)
    .sort()
    .join("\n");
  return {
    hash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    elements: [...names.values()],
    combine: (a, b) => recipes.get(pairKey(a, b)) ?? [],
  };
}

/**
 * Semantics ablation, after Brändle et al.'s "Tiny Pixels" condition: the same
 * graph with the names shuffled, so world knowledge cannot help. A judge that
 * scores as well here as on the real table was never using semantics.
 */
export function shuffleNames(table: Table, seed: number): Table {
  const rand = rng(seed);
  // Keep the four initial elements fixed: renaming them without renaming the
  // starting inventory would change which graph is reachable, not just semantics.
  const from = table.elements.filter((e) => !(BASE as readonly string[]).includes(e));
  const to = [...from];
  for (let i = to.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [to[i], to[j]] = [to[j], to[i]];
  }
  const map = new Map(from.map((n, i) => [n, to[i]]));
  const inverse = new Map(to.map((n, i) => [n, from[i]]));
  return {
    hash: `${table.hash}+shuffle:${seed}`,
    elements: table.elements.map((e) => map.get(e) ?? e),
    combine: (a, b) =>
      table.combine(inverse.get(a) ?? a, inverse.get(b) ?? b).map((r) => map.get(r) ?? r),
  };
}

/**
 * Synthetic world with controllable graph structure. Same BASE elements,
 * different recipe topology. Elements are ordinal ("s0", "s1", …) so semantics
 * cannot help — like shuffleNames but with a genuinely different graph.
 */
export function syntheticWorld(seed: number, opts?: {
  tiers?: number; perTier?: number; hubCount?: number;
}): Table {
  const rand = rng(seed);
  const tiers = opts?.tiers ?? 6;
  const perTier = opts?.perTier ?? 40;
  const hubCount = opts?.hubCount ?? 8;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(tiers) || tiers < 1 ||
      !Number.isSafeInteger(perTier) || perTier < 1 || !Number.isSafeInteger(hubCount) || hubCount < 0) {
    throw new Error("Invalid synthetic world parameters");
  }
  const draw = (n: number) => Math.floor(rand() * n);

  const elements: string[] = [...BASE];
  const recipes = new Map<string, string[]>();
  const addRecipe = (a: string, b: string, result: string) => {
    const key = pairKey(a, b);
    const existing = recipes.get(key) ?? [];
    if (!existing.includes(result)) recipes.set(key, [...existing, result]);
  };

  for (let tier = 1; tier <= tiers; tier++) {
    const pool = elements.length;
    for (let j = 0; j < perTier; j++) {
      const name = `s${elements.length - BASE.length}`;
      elements.push(name);
      // 1–2 recipes produce this element from the preceding tiers.
      const count = 1 + (rand() < 0.3 ? 1 : 0);
      for (let r = 0; r < count; r++) {
        const a = draw(pool);
        const b = draw(pool);
        addRecipe(elements[a], elements[b], name);
      }
    }
  }

  // Hubs: some early elements are extra-productive (appear in many recipes)
  const hubs = elements.slice(0, BASE.length + perTier);
  for (let i = hubs.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [hubs[i], hubs[j]] = [hubs[j], hubs[i]];
  }
  for (const hub of hubs.slice(0, hubCount)) {
    const extra = 5 + draw(15);
    for (let i = 0; i < extra; i++) {
      const partner = elements[draw(elements.length)];
      const result = elements[BASE.length + draw(elements.length - BASE.length)];
      addRecipe(hub, partner, result);
    }
  }

  const canonical = JSON.stringify({ elements, recipes: [...recipes.entries()] });
  return {
    hash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    elements,
    combine: (a, b) => recipes.get(pairKey(a, b)) ?? [],
  };
}

/** mulberry32 — a run is reproducible from (seed, step) alone. */
export function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
