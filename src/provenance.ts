// What produced a run, recorded in the run itself.
//
// The table is not the only mutable input to a decision: the policy is code and
// the prior is projected from other games. Pinning only the table repeats F4 one
// level up — the journal would say "empowerment" while the code behind that name
// had changed underneath, and no reader could tell.
//
// These hashes are provenance markers, not semantic versions. Reformatting a
// policy changes its hash without changing its behaviour; that is the safe
// direction to be wrong in.

import { createHash } from "node:crypto";
import type { Memory, Policy } from "./game/policies.js";

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;

export function hashPolicy(policy: Policy): string {
  return sha(String(policy));
}

/** Empty priors hash to "none" so a blind run reads as blind at a glance. */
export function hashMemory(memory?: Memory): string {
  if (!memory) return "none";
  const parts = [
    [...memory.deadPairs].sort().join("\n"),
    [...memory.productive].sort().join("\n"),
    [...memory.wins.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n"),
  ];
  if (parts.every((p) => p === "")) return "none";
  return sha(parts.join("\n--\n"));
}
