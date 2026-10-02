// Validation vs fresh score of every kept commit of a finished run, each compared with the
// previous kept commit by its own gate on the fresh cases. Shows which kept steps hold up.
//   node examples/autoresearch/curve.mjs TASK RUN_DIRECTORY
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gate } from "teob-mutara/gate";

const [taskName, directory] = process.argv.slice(2);
const task = (await import(`./tasks/${taskName}/task.mjs`)).default;
const run = resolve(directory), work = join(run, "work");
const git = (...a) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" }).trim();
const log = readFileSync(join(run, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const kept = [{ step: 0, score: log[0].score }, ...log.filter((e) => e.status === "keep")];
const revs = git("rev-list", "--reverse", "HEAD").split("\n"); // start, then one commit per kept step
const ext = task.file.slice(task.file.lastIndexOf("."));
const files = revs.map((rev, i) => { const f = join(run, "audit", `kept-${i}${ext}`); writeFileSync(f, git("show", `${rev}:${task.file}`) + "\n"); return f; });

const rows = [];
for (let i = 0; i < files.length; i++) {
  const prev = Math.max(0, i - 1);
  const scores = await task.audit(files[prev], files[i], task.freshCases);
  const mean = (k) => [...scores.values()].reduce((a, s) => a + s[k], 0) / scores.size;
  const verdict = i === 0 ? "" : (await gate({
    id: `curve-${taskName}-${i}`, storage: join(run, "curve.db"), implementation: { task: taskName, prev: revs[prev], rev: revs[i], harness: task.harness },
    cases: task.freshCases.map((id) => ({ id, input: null })),
    baseline: async (c) => ({ output: scores.get(c.id).baseline, cost: 0 }), candidate: async (c) => ({ output: scores.get(c.id).candidate, cost: 0 }),
    score: (o) => ({ score: o }), scoreRange: 1,
  })).verdict;
  rows.push({ step: kept[i].step, validation: kept[i].score, fresh: mean("candidate"), freshPrevious: i ? mean("baseline") : null, verdictVsPrevious: verdict });
}
console.log(JSON.stringify(rows, null, 2));
