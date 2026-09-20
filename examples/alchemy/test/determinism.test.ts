// The load-bearing test. Everything else in this repo assumes a recorded run
// can be replayed and compared; if the journal is not reproducible, the
// journal-as-corpus hypothesis is dead and no amount of tooling saves it.

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTable } from "../src/game/table.js";
import { policies } from "../src/game/policies.js";
import { applyStep, initialGame, playOffline, startGame, type GameState } from "../src/game/engine.js";
import { freshDb, harness } from "../src/harness.js";
import { readJournal } from "../src/memory.js";
import type { AlchemyEvent } from "../src/aggregate.js";

const table = loadTable();
const deps = { table, policies };
const db = (name: string) => freshDb(join(tmpdir(), `alchemy-${name}-${process.pid}.db`));
const ATTEMPTS = 40;

/** Journal contents with the storage-level columns dropped. */
const payloads = (path: string) =>
  readJournal(path).map((r) => `${r.sequence_nr} ${r.manifest} ${r.payload}`);

describe("replay determinism", () => {
  it("two runs of the same seed produce a byte-identical journal", async () => {
    const runOnce = async (name: string) => {
      const path = db(name);
      const h = harness(path, deps);
      await h.play("g1", 7, "empowerment", ATTEMPTS);
      await h.close();
      return payloads(path);
    };
    const a = await runOnce("det-a");
    // Guard against a vacuous pass: an empty journal compares equal to itself.
    expect(a.length).toBe(ATTEMPTS + 2); // game_started + N attempts + game_finished
    expect(a).toEqual(await runOnce("det-b"));
  });

  it("a different seed produces a different journal", async () => {
    const path = db("seeded");
    const h = harness(path, deps);
    await h.play("g1", 1, "empowerment", ATTEMPTS);
    await h.play("g2", 2, "empowerment", ATTEMPTS);
    await h.close();
    const g1 = readJournal(path, "g1").map((r) => r.payload);
    const g2 = readJournal(path, "g2").map((r) => r.payload);
    expect(g1).not.toEqual(g2);
  });

  it("state is a pure fold over the journal", async () => {
    const path = db("fold");
    const h = harness(path, deps);
    const live = await h.play("g1", 3, "empowerment", ATTEMPTS);
    await h.close();

    let folded: GameState = initialGame();
    for (const row of readJournal(path, "g1")) {
      const e = JSON.parse(row.payload) as AlchemyEvent;
      if (e.tag === "game_started") {
        folded = startGame(folded, e);
      } else if (e.tag === "pair_tried") {
        folded = applyStep(folded, e);
      } else {
        folded = { ...folded, status: "finished" };
      }
    }
    expect(folded).toEqual(live);
  });

  it("the journal pins the table the run was played against", async () => {
    const path = db("pinned");
    const h = harness(path, deps);
    await h.play("g1", 5, "random", 3);
    await h.close();
    const started = JSON.parse(readJournal(path, "g1")[0].payload) as AlchemyEvent;
    expect(started).toMatchObject({ tag: "game_started", tableHash: table.hash });
  });

  it("the aggregate and the offline engine play the same game", async () => {
    const path = db("parity");
    const h = harness(path, deps);
    const live = await h.play("g1", 11, "empowerment", ATTEMPTS);
    await h.close();
    const offline = playOffline(table, policies.empowerment, 11, ATTEMPTS);
    expect(live?.known).toEqual(offline.known);
    expect(live?.tried).toEqual(offline.tried);
  });
});
