// RAG retrieval: rank SciFact abstracts for scientific claims. Validation: mean nDCG@10 on 30
// fixed train queries, about the size of a hand-labelled set. Audit: the 300 test queries.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const here = (f) => new URL(f, import.meta.url).pathname;
const evaluate = async (...a) => JSON.parse((await promisify(execFile)("node", [here("eval.mjs"), ...a], { maxBuffer: 1 << 24, timeout: 600_000 })).stdout);
const split = JSON.parse(execFileSync("node", [here("eval.mjs"), "split"], { encoding: "utf8" }));
const test = readFileSync(here("data/scifact/qrels/test.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t")[0]);

export default {
  file: "retrieve.mjs",
  initial: here("retrieve.mjs"),
  comment: "//",
  goal: "The task: improve retrieval in retrieve.mjs. The corpus is 5183 biomedical abstracts (SciFact); queries are short scientific claims, and the relevant documents are the abstracts that support or refute them. The validation score is mean nDCG@10 over judged claims. No libraries, network or files are available: write the ranking yourself (tokenization, weighting, scoring). Indexing and 300 searches must finish within a few minutes.",
  unit: "nDCG@10",
  auditMetric: "mean nDCG@10 on fresh test queries",
  forbidden: /\bimport\b|\brequire\s*\(|\bprocess\b|\bfetch\s*\(|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(/,
  harness: createHash("sha256").update(readFileSync(here("eval.mjs"))).digest("hex"),
  freshCases: [...new Set(test)],
  validate: (file) => evaluate(file, "validation"),
  validationSize: 30,
  // For --rule seq and naive-pool: 779 judged train queries outside validation, never in the audit.
  searchCases: split.pool,
  compare: async (champion, candidate, ids) => {
    const [a, b] = await Promise.all([evaluate(champion, "pool", ...ids), evaluate(candidate, "pool", ...ids)]);
    return new Map(ids.map((id) => [id, { baseline: a[id], candidate: b[id] }]));
  },
  audit: async (start, champion, ids) => {
    const [a, b] = await Promise.all([evaluate(start, "fresh", ...ids), evaluate(champion, "fresh", ...ids)]);
    return new Map(ids.map((id) => [id, { baseline: a[id], candidate: b[id] }]));
  },
};
