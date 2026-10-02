// Frozen harness for the rag task. The agent never sees or edits this file or the data.
//   node eval.mjs FILE validation      -> {"score": mean nDCG@10 over 30 fixed train queries}
//   node eval.mjs FILE fresh ID...     -> {id: nDCG@10} for test queries
//   node eval.mjs FILE pool ID...      -> {id: nDCG@10} for judged train queries outside validation
//   node eval.mjs split                -> {validation: [ids], pool: [ids]} of the judged train queries
// search() sees only the query text; the judgements stay in this process.
import { readFileSync } from "node:fs";

const data = new URL("data/scifact/", import.meta.url).pathname;
const lines = (f) => readFileSync(data + f, "utf8").trim().split("\n");
const docs = lines("corpus.jsonl").map((l) => JSON.parse(l)).map((d) => ({ id: d._id, title: d.title, text: d.text }));
const queries = new Map(lines("queries.jsonl").map((l) => JSON.parse(l)).map((q) => [q._id, q.text]));
const qrels = (split) => {
  const out = new Map();
  for (const l of lines(`qrels/${split}.tsv`).slice(1)) {
    const [q, d, s] = l.split("\t");
    if (Number(s) > 0) out.set(q, new Set([...(out.get(q) ?? []), d]));
  }
  return out;
};
const ndcg = (ranked, relevant) => {
  const dcg = ranked.slice(0, 10).reduce((a, id, i) => a + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return dcg / ideal;
};

// Every 27th judged train query: 30 queries, the size of a hand-labelled set. The rest is the pool.
const train = qrels("train"), trainIds = [...train.keys()];
const validationIds = trainIds.filter((_, i) => i % 27 === 0).slice(0, 30);
const poolIds = trainIds.filter((q) => !validationIds.includes(q));
if (process.argv[2] === "split") {
  console.log(JSON.stringify({ validation: validationIds, pool: poolIds }));
  process.exit(0);
}
const [file, mode, ...ids] = process.argv.slice(2);
const { createIndex } = await import(file);
const index = createIndex(structuredClone(docs));
const run = (judged, qs) => Object.fromEntries(qs.map((q) => {
  const ranked = index.search(queries.get(q), 10);
  if (!Array.isArray(ranked)) throw new Error("search() must return an array of document ids");
  return [q, ndcg(ranked.map(String), judged.get(q))];
}));
if (mode === "validation") {
  const scores = Object.values(run(train, validationIds));
  console.log(JSON.stringify({ score: scores.reduce((a, b) => a + b, 0) / scores.length }));
} else if (mode === "fresh") console.log(JSON.stringify(run(qrels("test"), ids)));
else if (mode === "pool") {
  if (ids.some((q) => !poolIds.includes(q))) throw new Error("pool ids only");
  console.log(JSON.stringify(run(train, ids)));
} else throw new Error("Usage: eval.mjs FILE validation | FILE fresh ID... | FILE pool ID... | split");
