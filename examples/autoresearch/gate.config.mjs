// Final audit of an autoresearch branch: the champion commit against the starting commit,
// paired on fresh cases the loop never scored.
//
//   BASE=<start sha> HEAD=<champion sha> EVAL_CMD=./eval.sh CASES=fresh-cases.json \
//     npx teob-mutara gate examples/autoresearch/gate.config.mjs --out audit.json
//
// EVAL_CMD is your frozen harness, outside the files the agent edits. It is called as
// `EVAL_CMD <sha> <case id>` and prints one score in [0, 1] (pass rate, 1 - normalized
// latency, ...). CASES is a JSON array of case ids that never entered the loop.
// Exit codes: 0 promote, 1 reject, 3 inconclusive, 2 error.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const { BASE, HEAD, EVAL_CMD, CASES } = process.env;
if (!BASE || !HEAD || !EVAL_CMD || !CASES) throw new Error("Set BASE, HEAD, EVAL_CMD and CASES");
const run = promisify(execFile);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const evaluate = (sha) => async (c) => {
  const { stdout } = await run(EVAL_CMD, [sha, c.id], { maxBuffer: 1 << 20 });
  return { output: Number(stdout.trim()), cost: 1 };
};

export default {
  id: `autoresearch-audit-${BASE}-${HEAD}`,
  storage: "./autoresearch-audit.db",
  // Pins both commits, the harness and the case list: a changed harness is a new experiment.
  implementation: { base: BASE, head: HEAD, harness: sha256(EVAL_CMD), cases: sha256(CASES) },
  cases: JSON.parse(readFileSync(CASES, "utf8")).map((id) => ({ id: String(id), input: null })),
  baseline: evaluate(BASE),
  candidate: evaluate(HEAD),
  score: (output) => {
    if (!(output >= 0 && output <= 1)) throw new Error(`EVAL_CMD must print a score in [0, 1], got ${output}`);
    return { score: output };
  },
  scoreRange: 1,
  concurrency: 4,
};
