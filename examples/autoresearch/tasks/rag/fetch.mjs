// Downloads BEIR SciFact (about 3 MB) into data/: 5183 abstracts, scientific claims as queries,
// relevance judgements for 809 train and 300 test queries.
//   node examples/autoresearch/tasks/rag/fetch.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const data = new URL("data/", import.meta.url).pathname;
if (existsSync(`${data}scifact/corpus.jsonl`)) process.exit(0);
mkdirSync(data, { recursive: true });
const response = await fetch("https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip");
if (!response.ok) throw new Error(`download failed: ${response.status}`);
writeFileSync(`${data}scifact.zip`, Buffer.from(await response.arrayBuffer()));
execFileSync("unzip", ["-q", "-o", `${data}scifact.zip`, "-d", data]);
