// Does sharing episode seeds between baseline and candidate matter on Lunar Lander?
// Plan and results: examples/eval-bench/README.md. Lunar's own files stay untouched.
// Run: pnpm build && node examples/lunar/pairing.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { coreId, digest } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter as base, INITIAL, strategy, validateConfig } from "./experiment.mjs";
import { PROTOCOL, propose } from "./train.mjs";

const OFFSET = 1_000_000_000, WIND = 20, DIR = "runs/lunar-pairing", PARALLEL = 6;
const source = readFileSync(new URL(import.meta.url), "utf8");

// `independent`: the candidate flies other episodes than the baseline during selection. The audit stays shared.
const adapterFor = (pairing) => ({
  ...base,
  implementation: { ...base.implementation, "pairing.mjs": source, pairing },
  jobs: (champion, candidate, p) => base.jobs(champion, candidate, p).map((job) =>
    pairing === "independent" && p.phase === "selection" && job.key.endsWith(":candidate")
      ? { ...job, input: { ...job.input, seeds: job.input.seeds.map((s) => s + OFFSET) } } : job),
});

async function campaign(pairing, seed) {
  const id = `lunar-pairing-v1-${pairing}-${seed}`;
  const adapter = adapterFor(pairing);
  const h = learnerHarness(`${DIR}/${id}.db`, adapter);
  async function run(experimentId, plan) {
    const saved = await h.startOrResume(experimentId, plan);
    if (digest(saved.plan) !== digest(plan) || saved.coreId !== coreId ||
        saved.adapterId !== digest({ implementation: adapter.implementation, recovery: adapter.recovery })) {
      throw new Error("Campaign artifact changed; use a new ID");
    }
    const job = saved.status === "blocked" && saved.pending?.runs.find((r) => !r.receipt)?.job;
    if (job) await h.send(experimentId, { tag: "retry", jobId: job.id });
    return h.wait(experimentId);
  }
  try {
    let champion = strategy(INITIAL), accepted = 0;
    for (let generation = 0; generation < PROTOCOL.rounds; generation++) {
      const first = seed * 50000 + generation * 1000;
      const candidate = propose(champion.config, generation, seed);
      validateConfig(candidate);
      const state = await run(`${id}/trial-${generation}`, { initial: champion, candidate, rounds: 1, phase: "selection", wind: WIND,
        gate: "both", cases: { training: Array.from({ length: PROTOCOL.samples }, (_, i) => first + i),
          validation: Array.from({ length: PROTOCOL.samples }, (_, i) => first + 500 + i) } });
      champion = state.champion;
      accepted += Number(state.trials[0].accepted);
    }
    const final = await run(`${id}/final-test`, { initial: strategy(INITIAL), candidate: champion.config, rounds: 1, phase: "audit",
      wind: WIND, gate: "both", cases: { test: Array.from({ length: PROTOCOL.finalCases }, (_, i) => 3000000000 + seed * 2000 + i) } });
    const { test } = final.trials[0].evaluation;
    return { pairing, seed, accepted, stock: test.baseline, champion: test.candidate };
  } finally { await h.close(); }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
const fmt = (xs, d = 1) => `${mean(xs).toFixed(d)} ± ${se(xs).toFixed(d)}`;

mkdirSync(DIR, { recursive: true });
const queue = ["paired", "independent"].flatMap((pairing) => Array.from({ length: 10 }, (_, i) => [pairing, i + 1]));
const results = [];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (let next; (next = queue.shift());) {
    const r = await campaign(...next);
    results.push(r);
    console.log(`${r.pairing} seed ${r.seed}: accepted ${r.accepted}, champion ${r.champion.score.toFixed(1)} ` +
      `(${(100 * r.champion.solved).toFixed(0)}% solved), stock ${r.stock.score.toFixed(1)}`);
  }
}));
writeFileSync(`${DIR}/results.json`, JSON.stringify(results, null, 2));
const by = (pairing) => results.filter((r) => r.pairing === pairing).sort((a, b) => a.seed - b.seed);
const [paired, independent] = [by("paired"), by("independent")];
for (const [name, rows] of [["paired", paired], ["independent", independent]]) {
  console.log(`${name}: return ${fmt(rows.map((r) => r.champion.score))}, solved ${fmt(rows.map((r) => 100 * r.champion.solved))}%, ` +
    `accepted ${fmt(rows.map((r) => r.accepted))}`);
}
const diff = paired.map((r, i) => r.champion.score - independent[i].champion.score);
console.log(`paired - independent: ${fmt(diff)} → ${mean(diff) > 2 * se(diff) ? "paired better" :
  mean(diff) < -2 * se(diff) ? "independent better" : "no significant difference"}`);
