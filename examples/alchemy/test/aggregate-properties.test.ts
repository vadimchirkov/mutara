// Properties the aggregate is supposed to have, asserted rather than assumed:
// invariants hold over a real recorded journal, decision inputs are pinned in
// the journal, and an interrupted game resumes itself.

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityId } from "@lambda-house/teob-ts/core";
import { replayAndVerify } from "@lambda-house/teob-ts/core";
import { loadTable } from "../src/game/table.js";
import { policies } from "../src/game/policies.js";
import { freshDb, harness } from "../src/harness.js";
import { readJournal, projectMemory } from "../src/memory.js";
import { hashMemory, hashPolicy } from "../src/provenance.js";
import { createAlchemyAggregate, type AlchemyEvent } from "../src/aggregate.js";

const table = loadTable();
const deps = { table, policies };
const db = (name: string) => freshDb(join(tmpdir(), `alchemy-${name}-${process.pid}.db`));

const eventsOf = (path: string, id: string) =>
  readJournal(path, id).map((r) => JSON.parse(r.payload) as AlchemyEvent);

describe("aggregate properties", () => {
  it("invariants hold at every step of a recorded game", async () => {
    const path = db("invariants");
    const h = harness(path, deps);
    await h.play("g1", 4, "empowerment", 60);
    await h.close();

    const events = eventsOf(path, "g1");
    expect(events.length).toBeGreaterThan(60);
    const result = replayAndVerify(createAlchemyAggregate(deps), EntityId("g1"), events);
    expect(result.violations).toEqual([]);
    expect(result.eventsReplayed).toBe(events.length);
  });

  it("an invariant that should fail does fail", () => {
    // Without this, a green suite would not distinguish "invariants hold" from
    // "invariants are never evaluated".
    const broken = createAlchemyAggregate(deps);
    broken.invariants = [{ name: "impossible", check: (s) => s.known.length < 0 }];
    const result = replayAndVerify(broken, EntityId("g1"), [
      { tag: "game_started", seed: 1, policy: "random", attempts: 1, tableHash: "x", policyHash: "y", memoryHash: "none" },
    ]);
    expect(result.violations.map((v) => v.invariantName)).toEqual(["impossible"]);
  });

  it("the journal pins the policy code and the prior, not just their names", async () => {
    const path = db("provenance");
    const h = harness(path, deps);
    await h.play("g1", 1, "empowerment", 20);
    // Second game starts from a prior projected off the first.
    const memory = projectMemory(readJournal(path));
    const h2 = harness(path, { ...deps, memory });
    await h2.play("g2", 2, "empowerment", 20);
    await h.close();
    await h2.close();

    const [first] = eventsOf(path, "g1") as [Extract<AlchemyEvent, { tag: "game_started" }>];
    const [second] = eventsOf(path, "g2") as [Extract<AlchemyEvent, { tag: "game_started" }>];

    expect(first.policyHash).toBe(hashPolicy(policies.empowerment));
    expect(first.memoryHash).toBe("none");
    expect(second.memoryHash).toBe(hashMemory(memory));
    expect(second.memoryHash).not.toBe("none");
  });

  it("a game interrupted by a restart finishes itself", async () => {
    const path = db("recovery");
    const first = harness(path, deps);
    await first.start("g1", 9, "empowerment", 158);
    await first.close(); // shut down without waiting for the game to end

    const interrupted = eventsOf(path, "g1");
    expect(interrupted.some((e) => e.tag === "game_finished")).toBe(false);

    // A fresh runtime recovers the entity; onRecoveryComplete resumes the game.
    const second = harness(path, deps);
    await second.waitFinished("g1");
    const state = await second.state("g1");
    await second.close();

    expect(state?.status).toBe("finished");
    expect(state?.t).toBe(158);
  });
});
