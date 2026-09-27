// Summary of an all.mjs directory on the test split, and paired Mutara vs GEPA tests.
//   node examples/ifbench/compare.mjs DIRECTORY
// Per case, champion scores are averaged over seeds (the same 294 test cases each time),
// then an anytime-valid paired test runs in both directions; alpha 0.05 is split
// (Bonferroni) over every test printed. Calls and tokens come from the proxy ledgers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sequentialDecision } from "teob-mutara";
import { readLedger } from "./proxy.mjs";

const directory = resolve(process.argv[2] ?? "");
const SYSTEMS = ["mutara", "gepa"];
const load = (dir) => existsSync(join(dir, "report.json")) ? {
  report: JSON.parse(readFileSync(join(dir, "report.json"), "utf8")),
  ledger: readLedger(existsSync(join(dir, "ledger.jsonl")) ? readFileSync(join(dir, "ledger.jsonl"), "utf8") : ""),
} : null;
const models = readdirSync(directory, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const stats = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
  return `${(100 * m).toFixed(1)} ± ${(100 * sd).toFixed(1)}`;
};
const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const COMPARISONS = 2 * models.length;
const notes = new Set();

for (const model of models) {
  const seeds = readdirSync(join(directory, model)).filter((s) => /^s\d+$/.test(s)).sort();
  const runs = Object.fromEntries(SYSTEMS.map((system) => [system,
    seeds.map((s) => load(join(directory, model, s, system))).filter(Boolean)]));
  runs.mutara.concat(runs.gepa).forEach((r) => notes.add(r.report.note));
  console.log(`\n## ${model} (${seeds.length} seeds)\n`);
  console.log("| Program | Test score, % (mean ± sd over seeds) | Metric calls | LM calls | Tokens | Optimize wall, s |");
  console.log("|---|---|---|---|---|---|");
  for (const system of SYSTEMS) {
    const rs = runs[system];
    if (!rs.length) { console.log(`| ${system} | missing | | | | |`); continue; }
    const harness = system === "mutara" ? "plain chat" : "dspy ChainOfThought";
    console.log(`| Initial (${harness}) | ${stats(rs.map((r) => r.report.test.initial.mean))} | — | — | — | — |`);
    console.log(`| ${system === "mutara" ? "Mutara" : "GEPA"} (n=${rs.length}) | ${stats(rs.map((r) => r.report.test.champion.mean))} | ` +
      `${avg(rs.map((r) => r.report.metricCalls))} | ${avg(rs.map((r) => r.ledger.calls))} | ${avg(rs.map((r) => r.ledger.tokens))} | ` +
      `${avg(rs.map((r) => r.report.wallSeconds.optimize))} |`);
  }
  if (runs.mutara.length !== seeds.length || runs.gepa.length !== seeds.length) { console.log("\nPaired test: incomplete"); continue; }
  const perCase = (rs) => {
    const ids = Object.keys(rs[0].report.test.champion.scores).sort();
    return new Map(ids.map((id) => [id, rs.reduce((n, r) => n + r.report.test.champion.scores[id], 0) / rs.length]));
  };
  const [m, g] = [perCase(runs.mutara), perCase(runs.gepa)];
  const d = [...m.keys()].map((id) => m.get(id) - g.get(id));
  const test = (xs) => sequentialDecision(xs, { minimumGain: 0, range: 2, alpha: 0.05, comparisons: COMPARISONS });
  const [mg, gm] = [test(d), test(d.map((x) => -x))];
  const gain = d.reduce((a, b) => a + b, 0) / d.length;
  const verdict = mg.accepted ? "Mutara better" : gm.accepted ? "GEPA better" : "no significant difference";
  console.log(`\nPaired over ${d.length} test cases (seed-averaged), alpha 0.05 / ${COMPARISONS}: ` +
    `Mutara − GEPA = ${(100 * gain).toFixed(1)} pp → ${verdict} (Mutara > GEPA: ${mg.reason}; reverse: ${gm.reason})`);
}
console.log(`\n${[...notes].join(" ")}`);
