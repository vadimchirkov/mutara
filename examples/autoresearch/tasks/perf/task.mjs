// Perf: make topWords() faster without changing its output. Validation: median of 5 timings on
// one fixed text (what an autoresearch agent would run). Audit: fresh texts, start and champion
// timed in alternating order in one process; a case's score is that side's share of the pair's time.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const here = (f) => new URL(f, import.meta.url).pathname;
const bench = async (...a) => JSON.parse((await promisify(execFile)("node", [here("bench.mjs"), ...a], { maxBuffer: 1 << 24, timeout: 600_000 })).stdout);

export default {
  file: "wordfreq.mjs",
  initial: here("wordfreq.mjs"),
  comment: "//",
  goal: "The task: make topWords() in wordfreq.mjs as fast as possible on large texts (about 100k words, Zipf-distributed vocabulary). Its output must stay exactly the same for every input; a guard compares it with the original on several texts. The validation score is minus the median runtime in milliseconds.",
  unit: "-ms",
  auditMetric: "share of the paired time (0.5 = same speed, 0.67 = 2x faster)",
  // No imports, no I/O, no globals: the file is a pure function.
  forbidden: /\bimport\b|\brequire\s*\(|\bprocess\b|\bfetch\s*\(|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(/,
  harness: createHash("sha256").update(readFileSync(here("bench.mjs"))).digest("hex"),
  freshCases: Array.from({ length: 300 }, (_, i) => String(1000 + i)),
  validate: (file) => bench("validate", file),
  audit: async (start, champion, ids) => {
    const scores = new Map();
    for (const id of ids) scores.set(id, (await bench("audit", start, champion, id))[id]); // sequential: no contention
    return scores;
  },
};

