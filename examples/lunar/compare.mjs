// Campaign grid for the learned-model study, and its report.
//   node compare.mjs jobs  → one line per campaign: id seed wind controller auditWind (for a runner)
//   node compare.mjs       → replays every finished campaign from its journal (never runs Python) and prints
//                            audit tables plus paired significance tests on the shared held-out seeds.
import { existsSync } from "node:fs";
import { sequentialDecision } from "teob-mutara";

export const SEEDS = [7919, 2718, 31415];
export const CAMPAIGNS = [
  ...["heuristic", "hand", "fitted", "wind", "auto"].map((controller) => ({ controller, wind: 20, auditWind: 20 })),
  // Transfer: selected at wind 10, audited at wind 20.
  ...["heuristic", "hand", "fitted", "wind"].map((controller) => ({ controller, wind: 10, auditWind: 20 })),
];
export const id = (c, seed) => `lunar-v8-${c.controller}-w${c.wind}a${c.auditWind}-s${seed}`;
export const DIR = new URL("data/v8/", import.meta.url).pathname;

// Predeclared tests, each run in both directions. Bonferroni over all of them.
const key = (controller, wind) => `${controller}-w${wind}`;
const PAIRS = [
  ...["hand", "fitted", "wind", "auto"].map((c) => [key(c, 20), key("heuristic", 20)]),
  ...["hand", "fitted", "wind"].map((c) => [key(c, 10), key("heuristic", 10)]),
  ...[20, 10].flatMap((w) => [[key("fitted", w), key("hand", w)], [key("wind", w), key("hand", w)]]),
];
const COMPARISONS = 2 * PAIRS.length;

if (process.argv[2] === "jobs") {
  for (const seed of SEEDS) for (const c of CAMPAIGNS) console.log(id(c, seed), seed, c.wind, c.controller, c.auditWind);
} else {
  // Belt and braces: replayOnly refuses unfinished experiments, and a dead interpreter path means nothing can simulate.
  process.env.LUNAR_PYTHON = "/nonexistent/replay-only";
  const { train } = await import("./train.mjs");
  const reports = {};
  for (const c of CAMPAIGNS) for (const seed of SEEDS) {
    const storage = `${DIR}${id(c, seed)}.db`;
    if (!existsSync(storage)) { console.log(`missing ${id(c, seed)}`); continue; } // opening would create it
    try {
      (reports[key(c.controller, c.wind)] ??= {})[seed] = await train({ storage, id: id(c, seed),
        seed, wind: c.wind, controller: c.controller, auditWind: c.auditWind, replayOnly: true });
    } catch (error) {
      console.log(`missing ${id(c, seed)}: ${error.message.split("\n")[0]}`);
    }
  }
  const complete = (k) => reports[k] && SEEDS.every((s) => reports[k][s]);
  const fmt = (a) => `${a.score.toFixed(0)}, ${(a.solved * 100).toFixed(0)}%, ${a.failed} · ${(a.seconds * 1000).toFixed(0)} ms`;
  const pooled = (k, side) => {
    const all = SEEDS.flatMap((s) => reports[k][s].auditScores[side]);
    return { score: all.reduce((a, b) => a + b, 0) / all.length, solved: all.filter((x) => x >= 200).length / all.length,
      failed: all.filter((x) => x < 0).length };
  };
  for (const [k, byseed] of Object.entries(reports)) {
    console.log(`\n${k} (selected at wind ${k.split("-w")[1]}, audited at 20)`);
    for (const s of SEEDS) {
      const r = byseed[s];
      if (!r) continue;
      const m = r.champion.fitted === undefined ? "" : ` fitted=${r.champion.fitted} k=${r.champion.wind_k}`;
      console.log(`  ${s}: start ${fmt(r.audit.stock)} | tuned ${fmt(r.audit.champion)} | acc/caught ${r.accepted}/${r.caughtByValidation}${m}`);
    }
    if (complete(k)) {
      const p = pooled(k, "candidate");
      console.log(`  pooled tuned (600 episodes): ${p.score.toFixed(1)}, ${(p.solved * 100).toFixed(1)}%, ${p.failed}`);
    }
  }
  // Paired over identical audit episodes (same campaign seed → same 200 seeds, all audited at wind 20).
  console.log(`\nPaired tests on solved (return ≥ 200), 600 shared episodes, alpha 0.05 / ${COMPARISONS} (Bonferroni):`);
  for (const [a, b] of PAIRS) {
    if (!complete(a) || !complete(b)) { console.log(`  ${a} vs ${b}: incomplete`); continue; }
    const scores = (k) => SEEDS.flatMap((s) => reports[k][s].auditScores.candidate);
    const [x, y] = [scores(a), scores(b)];
    const diff = (u, v) => u.map((s, i) => (s >= 200) - (v[i] >= 200));
    const test = (d) => sequentialDecision(d, { minimumGain: 0, range: 2, alpha: 0.05, comparisons: COMPARISONS });
    const [ab, ba] = [test(diff(x, y)), test(diff(y, x))];
    const gain = x.reduce((acc, s, i) => acc + s - y[i], 0) / x.length;
    const solvedGain = diff(x, y).reduce((acc, d) => acc + d, 0) / x.length;
    const verdict = ab.accepted ? `${a} better` : ba.accepted ? `${b} better` : "no significant difference";
    console.log(`  ${a} vs ${b}: Δreturn ${gain.toFixed(1)}, Δsolved ${(solvedGain * 100).toFixed(1)} pp → ${verdict}` +
      ` (${a} > ${b}: ${ab.reason}; reverse: ${ba.reason})`);
  }
}
