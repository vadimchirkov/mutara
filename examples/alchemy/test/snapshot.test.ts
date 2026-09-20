// Snapshots are on by default at every 100 events and a full game emits ~160,
// so every bench run crosses the threshold — but the determinism tests run 40
// attempts and never do. That gap is exactly how F9/F10 stayed invisible in the
// framework: the write succeeds, the decode succeeds, and the damage only shows
// up as an empty collection much later.

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTable } from "../src/game/table.js";
import { policies } from "../src/game/policies.js";
import { freshDb, harness } from "../src/harness.js";

const table = loadTable();
const deps = { table, policies };
const ATTEMPTS = 158; // > snapshotEvery (100)

describe("snapshot round trip", () => {
  it("a full-length game survives being reloaded from its snapshot", async () => {
    const path = freshDb(join(tmpdir(), `alchemy-snap-${process.pid}.db`));

    const first = harness(path, deps);
    const live = await first.play("g1", 3, "empowerment", ATTEMPTS);
    await first.close();

    const d = new Database(path, { readonly: true });
    const snaps = d.prepare("SELECT sequence_nr FROM snapshots").all() as Array<{ sequence_nr: number }>;
    d.close();
    // Guard against a vacuous pass: with no snapshot this test proves nothing.
    expect(snaps.length).toBeGreaterThan(0);

    // A second runtime over the same journal recovers through the snapshot.
    const second = harness(path, deps);
    const recovered = await second.play("g1", 0, "empowerment", 0);
    await second.close();

    expect(recovered).toEqual(live);
    // The collections are what a Map/Set in state would have silently lost.
    expect(recovered?.known.length).toBe(live?.known.length);
    expect(recovered?.tried.length).toBe(live?.tried.length);
    expect(Object.keys(recovered?.wins ?? {}).length).toBeGreaterThan(0);
  });
});
