// Shared pieces of the IFBench benchmark: splits, the two-stage program Mutara optimizes,
// and the Python scorer (metric.py) as a long-lived subprocess.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const here = (file) => new URL(file, import.meta.url).pathname;

// GEPA's IFBenchCoT2StageProgram: its two signature docstrings are the initial instructions.
export const INITIAL_PROMPT = {
  generate: "Respond to the query",
  ensure: "Ensure the response is correct and adheres to the given constraints. Your response will be used as the final response.",
};
export const OBJECTIVE = "A two-stage program answers a user query that carries explicit output constraints " +
  "(keywords, counts, formatting, casing, structure). Stage `generate` drafts a response; stage `ensure` " +
  "rewrites it and its output is final. Score: the fraction of the query's constraints the final response satisfies.";

export function loadSplits() {
  if (!existsSync(here("data/test.jsonl"))) throw new Error("Run node examples/ifbench/fetch.mjs first");
  const read = (name) => readFileSync(here(`data/${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { train: read("train"), val: read("val"), test: read("test") };
}

/** One rollout: two chat calls. Returns the final text and the tokens of both calls. */
export async function runProgram(chat, prompts, query) {
  const draft = await chat([{ role: "system", content: prompts.generate }, { role: "user", content: query }]);
  const final = await chat([{ role: "system", content: prompts.ensure },
    { role: "user", content: `Query:\n${query}\n\nResponse:\n${draft.text}` }]);
  return { text: final.text, tokens: draft.tokens + final.tokens };
}

// Pinned checker environment; IFBENCH_PYTHON=/path/to/python (with these packages) skips uv.
export const PYTHON = process.env.IFBENCH_PYTHON ? [process.env.IFBENCH_PYTHON] : ["uv", "run", "-q", "--python", "3.12",
  "--with", "nltk==3.9.1", "--with", "spacy==3.8.7", "--with", "langdetect==1.0.9", "--with", "emoji==2.14.1",
  "--with", "syllapy==0.7.2", "--with", "immutabledict==4.2.1", "--with",
  "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
  "python"];

/** Start metric.py once; `score(case, response)` resolves to { score, feedback, followed }. */
export function scorer() {
  const [command, ...args] = PYTHON;
  const child = spawn(command, [...args, here("metric.py"), "--serve"], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  let failure = null;
  const fail = (error) => { failure = error; while (waiting.length) waiting.shift().reject(error); };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`metric.py exited with ${code}`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    const next = waiting.shift();
    if (reply.error) next.reject(new Error(`metric.py: ${reply.error}`)); else next.resolve(reply);
  });
  return {
    // metric.py answers in request order, one line each.
    score: (row, response) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting.push({ resolve, reject });
      child.stdin.write(JSON.stringify({ case: { prompt: row.prompt, instruction_id_list: row.instruction_id_list, kwargs: row.kwargs }, response }) + "\n");
    }),
    close: () => { child.removeAllListeners("exit"); child.stdin.end(); },
  };
}
