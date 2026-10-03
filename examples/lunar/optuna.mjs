// Experiment 6: Optuna TPE through the ask/tell bridge, then one gate on the release (arms B and C).
// B: 60 trials × 60 fresh episodes (= the hill-climb's 3600), release = best by the search's own estimate.
// C: same journal, plus gate(best vs stock) on 100 fresh seeds; promote releases best, else stock.
// Audit for both: the hill-climb's 200 held-out seeds for this campaign seed, wind 20.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { coreId, digest } from "teob-mutara";
import { gate } from "teob-mutara/gate";
import { learnerHarness } from "teob-mutara/sqlite";
import { askTell } from "../search-bridge/ask-tell.mjs";
import { adapter as lunar, bounds, implementation as lunarImplementation, INITIAL, strategy as lunarStrategy, validateConfig } from "./experiment.mjs";

const ASK = ["uv", "run", "-q", "--python", "3.12", "--with", "optuna==5.0.0", "--with", "numpy==2.5.3", "python",
  new URL("../search-bridge/optuna_ask.py", import.meta.url).pathname];
const files = ["../search-bridge/optuna_ask.py", "../search-bridge/ask-tell.mjs", "optuna.mjs"];
const implementation = { lunar: lunarImplementation, ask: ASK.slice(0, -1),
  files: Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, import.meta.url), "utf8")])) };
const SPACE = Object.fromEntries(Object.keys(INITIAL).map((k) => [k, bounds(k, INITIAL)]));
// Python calls made by this process; a resumed campaign must not repeat recorded trials.
export const calls = { ask: 0, simulate: 0 };

function ask(history, plan) {
  calls.ask++;
  const r = spawnSync(ASK[0], ASK.slice(1), { input: JSON.stringify({ space: SPACE, history, seed: plan.seed, initial: INITIAL }),
    encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`optuna_ask.py failed: ${r.stderr || r.error?.message}`);
  return JSON.parse(r.stdout).config;
}
const bridge = askTell({ implementation, ask, validateConfig,
  validatePlan(p) {
    if (!Number.isSafeInteger(p.seed) || p.seed < 1 || p.seed > 40000 || p.wind !== 20 ||
        !Number.isSafeInteger(p.episodes) || p.episodes < 1 || p.episodes > 800) throw new Error("Invalid Optuna campaign");
  },
  limits: (p) => ({ executions: p.rounds, cost: p.rounds * p.episodes }),
  // Fresh seeds per trial; disjoint from the audit (3e9 + seed·2000) and gate (3.1e9 + seed·1000) ranges.
  jobs: (config, p, round) => [{ key: "trial", costLimit: p.episodes, input: { config, wind: p.wind, controller: "heuristic",
    seeds: Array.from({ length: p.episodes }, (_, i) => p.seed * 50000 + round * 800 + i) } }],
  async execute(job) { calls.simulate++; return lunar.execute(job); },
  grade(job, receipt) {
    const { metrics, data } = lunar.grade(job, receipt);
    return { metrics: { value: metrics.score }, data };
  },
});

async function journaled(storage, adapter, id, plan, options) {
  const h = learnerHarness(storage, adapter, options);
  try {
    const before = await h.state(id);
    const saved = await h.startOrResume(id, plan);
    if (digest(saved.plan) !== digest(plan) || saved.coreId !== coreId ||
        saved.adapterId !== digest({ implementation: adapter.implementation, recovery: adapter.recovery })) {
      throw new Error("Campaign artifact changed; restore it or use a new ID");
    }
    return { before, state: await h.wait(id, 3_600_000) };
  } finally { await h.close(); }
}
const episode = (config, seed) => lunar.execute({ input: { config, seeds: [seed], wind: 20, controller: "heuristic" } })
  .then(({ output }) => ({ output: output.rows[0].score, cost: 1 }));

export async function campaign({ dir, seed, trials = 60, episodes = 60, gateCases = 100, prefix = "lunar-x6" }) {
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const id = `${prefix}-optuna-s${seed}`;
  const plan = { initial: bridge.strategy(INITIAL), rounds: trials, seed, wind: 20, episodes };
  const { before, state } = await journaled(join(dir, "search.db"), bridge.adapter, id, plan, { category: "ask-tell" });
  const history = bridge.history(state);
  const best = bridge.best(state);
  const duplicates = history.length - new Set(history.map((h) => JSON.stringify(Object.entries(h.config).sort()))).size;
  const searchCalls = { ...calls };

  // C: one gate on the release. Violation = a failed landing (return < 0), as in the hill-climb's rule.
  const isStock = JSON.stringify(Object.entries(best.config).sort()) === JSON.stringify(Object.entries(INITIAL).sort());
  const gateResult = isStock ? { verdict: "skipped: release is stock", reason: "", cases: 0, baseline: {}, candidate: {} } : await gate({ id: `${prefix}-gate-s${seed}`, storage: join(dir, "gate.db"),
    implementation: { lunar: lunarImplementation, stock: INITIAL, best: best.config, wind: 20, protocol: "lunar-x6-gate" },
    cases: Array.from({ length: gateCases }, (_, i) => ({ id: String(3_100_000_000 + seed * 1000 + i) })),
    baseline: (c) => episode(INITIAL, Number(c.id)), candidate: (c) => episode(best.config, Number(c.id)),
    score: (output) => ({ score: output, violation: Number(output < 0) }),
    scoreRange: 1000, minimumGain: 0, concurrency: 8 });

  // Audit: stock vs B's release on the same 200 held-out seeds as train.mjs for this campaign seed.
  const auditPlan = { initial: lunarStrategy(INITIAL), candidate: best.config, rounds: 1, phase: "audit", wind: 20, gate: "both",
    cases: { test: Array.from({ length: 200 }, (_, i) => 3000000000 + seed * 2000 + i) } };
  const { state: audited } = await journaled(join(dir, "audit.db"), lunar, `${prefix}-audit-s${seed}`, auditPlan);
  const { runtime, test } = audited.trials[0].evaluation;
  const promoted = gateResult.verdict === "promote";
  const report = { id, seed, trials, episodes, runtime, optuna: "5.0.0",
    resumedFrom: { trials: before.trials.length, pending: Boolean(before.pending) },
    pythonCalls: { ask: searchCalls.ask, simulate: searchCalls.simulate },
    duplicates, best: { trial: history.findIndex((h) => h.value === best.value), value: best.value, config: best.config },
    gate: { verdict: gateResult.verdict, reason: gateResult.reason, cases: gateResult.cases, episodes: 2 * gateResult.cases,
      stock: gateResult.baseline.mean, best: gateResult.candidate.mean },
    audit: { stock: test.baseline, B: test.candidate, C: promoted ? test.candidate : test.baseline },
    gap: best.value - test.candidate.score, seconds: (Date.now() - started) / 1000,
    history: history.map((h) => h.value) };
  writeFileSync(join(dir, `${prefix}-s${seed}.json`), JSON.stringify(report, null, 1));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, seed, trials = "60", episodes = "60", gateCases = "100", prefix = "lunar-x6"] = process.argv.slice(2);
  try {
    const r = await campaign({ dir, seed: Number(seed), trials: Number(trials), episodes: Number(episodes), gateCases: Number(gateCases), prefix });
    console.log(JSON.stringify({ ...r, history: undefined }, null, 1));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
