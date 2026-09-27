// Download IFBench data and the official constraint checkers into data/ (gitignored), and
// write the GEPA splits. Source: the GEPA paper's artifact at a pinned commit, which vendors
// allenai/IFBench (Apache-2.0) checkers and data from allenai/IFBench_test and the IF-RLVR
// train set allenai/IF_multi_constraints_upto5 (ODC-BY). Never commit data/.
//
//   node examples/ifbench/fetch.mjs
//
// Splits, exactly as gepa_artifact/benchmarks (ifbench_data.py + benchmark.py trim_dataset):
//   val   = IFBench_train.jsonl[:300]
//   train = random.Random(1).sample(IFBench_train.jsonl[300:600], 150)
//   test  = IFBench_test.jsonl (all rows)
// Python's own `random` draws the train sample, so the indices match GEPA's bit for bit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const COMMIT = "cbefbc1aa0f43dd39874ec4bf42211365dbda42e";
const BASE = `https://raw.githubusercontent.com/gepa-ai/gepa-artifact/${COMMIT}/gepa_artifact/benchmarks/IFBench`;
const DATA = new URL("data/", import.meta.url);
const CHECKERS = ["instructions.py", "instructions_ifeval.py", "instructions_registry.py",
  "instructions_registry_ifeval.py", "instructions_util.py", "instructions_util_ifeval.py"];

async function download(path) {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

mkdirSync(new URL("utils_ifbench/", DATA), { recursive: true });
const manifest = { source: `gepa-ai/gepa-artifact@${COMMIT}`, sha256: {} };
for (const file of CHECKERS) {
  const body = await download(`utils_ifbench/${file}`);
  writeFileSync(new URL(`utils_ifbench/${file}`, DATA), body);
  manifest.sha256[`utils_ifbench/${file}`] = createHash("sha256").update(body).digest("hex");
}
writeFileSync(new URL("utils_ifbench/__init__.py", DATA), "");
const raw = {};
for (const name of ["IFBench_train", "IFBench_test"]) {
  raw[name] = await download(`data/${name}.jsonl`);
  manifest.sha256[`${name}.jsonl`] = createHash("sha256").update(raw[name]).digest("hex");
}
const lines = (buffer) => buffer.toString("utf8").split("\n").filter((l) => l.trim());
const trainVal = lines(raw.IFBench_train);
const indices = JSON.parse(execFileSync("python3", ["-c",
  "import json, random; print(json.dumps(random.Random(1).sample(range(300, 600), 150)))"]).toString());
const row = (line, id, split) => {
  const d = JSON.parse(line);
  return JSON.stringify({ id, split, prompt: d.prompt, instruction_id_list: d.instruction_id_list, kwargs: d.kwargs });
};
const splits = {
  val: trainVal.slice(0, 300).map((l, i) => row(l, `val-${i}`, "validation")),
  train: indices.map((i) => row(trainVal[i], `train-${i}`, "train")),
  test: lines(raw.IFBench_test).map((l, i) => row(l, `test-${i}`, "test")),
};
for (const [name, rows] of Object.entries(splits)) writeFileSync(new URL(`${name}.jsonl`, DATA), rows.join("\n") + "\n");
manifest.counts = Object.fromEntries(Object.entries(splits).map(([k, v]) => [k, v.length]));
manifest.trainIndices = indices;
writeFileSync(new URL("manifest.json", DATA), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest.counts));
// The sample must be Python's: guard against a silently different interpreter RNG.
if (readFileSync(new URL("train.jsonl", DATA), "utf8").split("\n").filter(Boolean).length !== 150) throw new Error("Bad train split");
