import { createHash } from "node:crypto";

/** Canonical, finite JSON is the boundary for persisted adapter artifacts. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("Expected finite JSON data");
}
export const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
export interface Identity { id: string; parentId: string | null }
export interface Version<T> extends Identity { implementationId: string; config: T }
export function version<T>(config: T, implementationId: string, parentId: string | null = null): Version<T> {
  const content = { config: structuredClone(config), implementationId, parentId };
  return { id: digest(content), ...content };
}
export function validateVersion<T>(v: Version<T>, implementationId: string) {
  if (v.implementationId !== implementationId || version(v.config, implementationId, v.parentId).id !== v.id) {
    throw new Error("Version artifact or implementation changed");
  }
}
