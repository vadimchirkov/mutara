import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { learnerHarness } from "../src/sqlite.js";
// @ts-ignore — standalone example.
import { askTell } from "../examples/search-bridge/ask-tell.mjs";

type H = { config: { x: number }; value: number }[];
// Toy searcher: a deterministic function of history that steps from the best point so far.
const toyAsk = (h: H) => ({ x: h.length ? h.reduce((a, b) => (b.value > a.value ? b : a)).config.x + 1 / (h.length + 1) : 0 });
function toy(counts: { ask: number; execute: number }, hang = -1) {
  return askTell({
    implementation: { toy: 1 },
    ask: (h: H) => { counts.ask++; return toyAsk(h); },
    jobs: (config: { x: number }, _p: unknown, round: number) => [{ key: "eval", input: { config, round }, costLimit: 1 }],
    execute: async (job: { input: { config: { x: number }; round: number } }) => {
      counts.execute++;
      // A trial whose process dies: the promise never settles, like a kill -9 mid-execution.
      if (job.input.round === hang) return new Promise(() => {});
      return { output: -((job.input.config.x - 1) ** 2), cost: 1 };
    },
    grade: (_job: unknown, receipt: { output: number }) => ({ metrics: { value: receipt.output }, data: null }),
    limits: (p: { rounds: number }) => ({ executions: p.rounds, cost: p.rounds }),
  });
}

it("ask/tell bridge proposes deterministically and never repeats a candidate", () => {
  const counts = { ask: 0, execute: 0 };
  const { adapter, strategy } = toy(counts);
  const initial = strategy({ x: 0 });
  const trials = [0, 0.5].map((x) => ({ candidate: strategy({ x }, initial.id), evaluation: { value: -((x - 1) ** 2) } }));
  const plan = { initial, rounds: 5 };
  expect(adapter.propose(initial, trials, plan).id).toBe(adapter.propose(initial, trials, plan).id);
  const repeating = askTell({ implementation: { toy: 2 }, ask: () => ({ x: 0 }), jobs: () => [], execute: async () => ({}), grade: () => null, limits: () => ({}) });
  expect(() => repeating.adapter.propose(initial, trials, plan)).toThrow(/repeated a candidate/);
});

it("ask/tell bridge resumes after a crash without re-asking or re-executing recorded trials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-tell-"));
  const storage = join(dir, "bridge.db"), rounds = 8, hang = 3;
  try {
    const first = { ask: 0, execute: 0 };
    const a = toy(first, hang);
    const plan = { initial: a.strategy({ x: 0 }), rounds };
    let h = learnerHarness(storage, a.adapter);
    await h.startOrResume("toy", plan);
    for (let s = await h.state("toy"); !s.pending?.runs[0]?.requested || s.pending.round !== hang; s = await h.state("toy")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await h.close();
    expect(first).toEqual({ ask: hang + 1, execute: hang + 1 });

    const second = { ask: 0, execute: 0 };
    const b = toy(second);
    h = learnerHarness(storage, b.adapter);
    await h.startOrResume("toy", plan);
    const state = await h.wait("toy");
    await h.close();
    // Recorded trials 0..2 and the proposal of trial 3 replay from the journal; only trial 3's lost run reruns.
    expect(second).toEqual({ ask: rounds - hang - 1, execute: rounds - hang });
    const history = b.history(state);
    // Same sequence as an uninterrupted search: every config is ask() of its own journaled prefix.
    expect(history.length).toBe(rounds);
    history.forEach((t: H[number], i: number) => expect(t.config).toEqual(toyAsk(history.slice(0, i))));
    expect(new Set(history.map((t: { config: { x: number } }) => t.config.x)).size).toBe(rounds);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
