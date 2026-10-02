#!/usr/bin/env node
// mutara gate CONFIG [--out report.json]
//
// CONFIG is an ES module whose default export is the options of `gate` from
// `teob-mutara/gate` (or a function returning them). Exit codes: 0 promote, 1 reject,
// 3 inconclusive, 2 usage or runtime error. Writes a Markdown summary to
// $GITHUB_STEP_SUMMARY when set.
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gate } from "../dist/gate.js";

const [command, config, ...rest] = process.argv.slice(2);
if (command !== "gate" || !config) {
  console.error("Usage: mutara gate CONFIG.mjs [--out report.json]");
  process.exit(2);
}
const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : null;
try {
  const loaded = (await import(pathToFileURL(resolve(config)).href)).default;
  const result = await gate(typeof loaded === "function" ? await loaded() : loaded);
  const report = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, report + "\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const row = (name, s) => `| ${name} | ${s.mean.toFixed(4)} | ${s.violations} | ${s.cost} |`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### Mutara gate: **${result.verdict}**`, "",
      `${result.cases} paired cases. ${result.reason}`, "",
      "| Side | Mean score | Violations | Cost |", "|---|---|---|---|",
      row("Baseline", result.baseline), row("Candidate", result.candidate), "", ""].join("\n"));
  }
  process.exit({ promote: 0, reject: 1, inconclusive: 3 }[result.verdict]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
