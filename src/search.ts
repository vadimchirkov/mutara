import { version, type Version } from "./version.js";

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FloatDim = { type: "float"; min: number; max: number; initial: number };
export type IntDim = { type: "int"; min: number; max: number; initial: number };
export type EnumDim = { type: "enum"; values: string[]; initial: string };
export type Dimension = FloatDim | IntDim | EnumDim;
export type Space = Record<string, Dimension>;

export function validateSpace(space: Space) {
  if (!Object.keys(space).length) throw new Error("At least one dimension required");
  for (const [key, dim] of Object.entries(space)) {
    switch (dim.type) {
      case "float":
      case "int":
        if (!Number.isFinite(dim.min) || !Number.isFinite(dim.max) || !Number.isFinite(dim.max - dim.min) || dim.min >= dim.max ||
            !Number.isFinite(dim.initial) || dim.initial < dim.min || dim.initial > dim.max) throw new Error(`Invalid dimension ${key}`);
        if (dim.type === "int" && (!Number.isSafeInteger(dim.min) || !Number.isSafeInteger(dim.max) || !Number.isSafeInteger(dim.initial) || !Number.isSafeInteger(dim.max - dim.min + 1))) throw new Error(`Integer dimension ${key} needs safe integer bounds`);
        break;
      case "enum":
        if (!Array.isArray(dim.values) || !dim.values.length || dim.values.some((v) => typeof v !== "string") || new Set(dim.values).size !== dim.values.length ||
            !dim.values.includes(dim.initial)) throw new Error(`Invalid enum dimension ${key}`);
        break;
      default: throw new Error(`Unknown dimension type in ${key}`);
    }
  }
}

export function initialConfig(space: Space): Record<string, unknown> {
  return Object.fromEntries(Object.entries(space).map(([key, dim]) => [key, dim.initial]));
}

export function sampleRandom(space: Space, rand: () => number): Record<string, unknown> {
  return Object.fromEntries(Object.keys(space).sort().map((key) => {
    const dim = space[key];
    switch (dim.type) {
      case "float": return [key, dim.min + rand() * (dim.max - dim.min)];
      case "int": return [key, dim.min + Math.floor(rand() * (dim.max - dim.min + 1))];
      case "enum": return [key, dim.values[Math.floor(rand() * dim.values.length)]];
    }
  }));
}

export function randomPropose(space: Space, implementationId: string, champion: Version<Record<string, unknown>>, round: number, seed: number): Version<Record<string, unknown>> {
  return version(sampleRandom(space, rng(seed + round * 0x9e3779b9)), implementationId, champion.id);
}
