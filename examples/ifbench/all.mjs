// The whole IFBench matrix in one command: models × seeds × {Mutara, GEPA}, both sides
// through one accounting proxy, then the comparison table.
//
//   MUTARA_LLM_BASE_URL=... MUTARA_LLM_API_KEY=... MUTARA_LLM_MODELS=model-a,model-b \
//     node examples/ifbench/all.mjs NEW_DIRECTORY [--budget 3593] [--concurrency 8] [--dry]
//
// Each run writes <dir>/<model>/s<seed>/<system>/{report.json,ledger.jsonl}; runs with a
// report are skipped, others resume from their own checkpoints. The initial program is
// evaluated on test inside each run. `--dry` answers with a stub model: wiring only.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PYTHON } from "./program.mjs";
import { startProxy } from "./proxy.mjs";

export const SEEDS = [7919, 2718, 31415];
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--budget", "--concurrency"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/ifbench/all.mjs NEW_DIRECTORY [options]");
const dry = args.includes("--dry");
const budget = flag("--budget", "3593"), concurrency = flag("--concurrency", "8");
const models = (process.env.MUTARA_LLM_MODELS || process.env.MUTARA_LLM_MODEL || (dry ? "stub-a,stub-b" : "")).split(",").filter(Boolean);
if (!models.length) throw new Error("Set MUTARA_LLM_MODELS (comma-separated) or MUTARA_LLM_MODEL");

const here = (file) => new URL(file, import.meta.url).pathname;
const gepaPython = process.env.IFBENCH_PYTHON ? PYTHON : [...PYTHON.slice(0, -1), "--with", "dspy==3.4.0", "python"];
const run = (command, argv, env) => new Promise((ok, fail) => {
  const child = spawn(command, argv, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });
  child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${command} exited with ${code}`))));
});

const proxy = await startProxy({ upstream: process.env.MUTARA_LLM_BASE_URL, stub: dry, ledger: (tag) => join(tag, "ledger.jsonl") });
try {
  for (const model of models) for (const seed of SEEDS) for (const system of ["mutara", "gepa"]) {
    const dir = resolve(directory, model.replaceAll("/", "_"), `s${seed}`, system);
    if (existsSync(join(dir, "report.json"))) continue;
    mkdirSync(dir, { recursive: true });
    console.error(`\n== ${model} seed ${seed} ${system}`);
    const env = { MUTARA_LLM_BASE_URL: proxy.url(dir), MUTARA_LLM_MODEL: model };
    const common = [dir, "--seed", String(seed), "--budget", budget, ...(dry ? ["--dry"] : [])];
    if (system === "mutara") await run(process.execPath, [here("run.mjs"), ...common, "--concurrency", concurrency], env);
    else await run(gepaPython[0], [...gepaPython.slice(1), here("gepa_baseline.py"), ...common, "--threads", concurrency], env);
    if (!existsSync(join(dir, "report.json"))) throw new Error(`${system} wrote no report in ${dir}`);
  }
} finally { await proxy.close(); }
await run(process.execPath, [here("compare.mjs"), directory]);
