// Crash-recovery measurement: for each system, one uninterrupted run and one run killed with
// SIGKILL (whole process group) after --kill-at paid calls, then restarted on the same
// directory until it finishes. Paid calls come from the proxy ledger, which outlives the kill.
//
//   node examples/ifbench/crash.mjs NEW_DIRECTORY [--dry] [--budget 1200] [--kill-at 600] [--concurrency 8]
//
// --systems mutara,gepa (default both) limits the systems measured.
// Without --dry it uses MUTARA_LLM_BASE_URL / MUTARA_LLM_MODEL like all.mjs (and pays for it).
// With --dry a stub model answers deterministically: this measures orchestration (which calls
// are paid twice), not model quality, and the report says so.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PYTHON } from "./program.mjs";
import { readLedger, startProxy } from "./proxy.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--budget", "--kill-at", "--concurrency", "--systems"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/ifbench/crash.mjs NEW_DIRECTORY [options]");
const dry = args.includes("--dry");
const budget = flag("--budget", "1200"), killAt = Number(flag("--kill-at", 600)), concurrency = flag("--concurrency", "8");
const model = dry ? "stub" : process.env.MUTARA_LLM_MODEL;
const here = (file) => new URL(file, import.meta.url).pathname;
const gepaPython = process.env.IFBENCH_PYTHON ? PYTHON : [...PYTHON.slice(0, -1), "--with", "dspy==3.4.0", "python"];
const ledgerOf = (dir) => existsSync(join(dir, "ledger.jsonl")) ? readLedger(readFileSync(join(dir, "ledger.jsonl"), "utf8")) : { calls: 0, tokens: 0 };
const proxy = await startProxy({ upstream: process.env.MUTARA_LLM_BASE_URL, stub: dry, ledger: (tag) => join(tag, "ledger.jsonl") });

function start(system, dir) {
  const common = [dir, "--seed", "7919", "--budget", budget, ...(dry ? ["--dry"] : [])];
  const [command, ...argv] = system === "mutara"
    ? [process.execPath, here("run.mjs"), ...common, "--concurrency", concurrency]
    : [...gepaPython, here("gepa_baseline.py"), ...common, "--threads", concurrency];
  // Own process group, so SIGKILL reaches uv's Python child and the scorer too.
  const child = spawn(command, argv, { detached: true, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, MUTARA_LLM_BASE_URL: proxy.url(dir), MUTARA_LLM_MODEL: model } });
  const exited = new Promise((ok) => child.on("exit", (code, signal) => ok(signal ?? code)));
  return { child, exited };
}
async function finish(system, dir) {
  const { exited } = start(system, dir);
  const code = await exited;
  if (code !== 0) throw new Error(`${system} in ${dir} exited with ${code}`);
  return JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
}

const result = { note: dry ? "Stub model: measures which calls are paid again after SIGKILL, not quality." : "Real endpoint.",
  budget: Number(budget), killAt, concurrency: Number(concurrency) };
try {
  for (const system of flag("--systems", "mutara,gepa").split(",")) {
    const reference = resolve(directory, system, "reference"), crashed = resolve(directory, system, "crashed");
    mkdirSync(reference, { recursive: true }); mkdirSync(crashed, { recursive: true });
    const clean = await finish(system, reference);
    const { child, exited } = start(system, crashed);
    let killed = false;
    while (!killed && (await Promise.race([exited.then(() => "exit"), new Promise((r) => setTimeout(() => r("tick"), 50))])) === "tick") {
      if (ledgerOf(crashed).calls >= killAt) { process.kill(-child.pid, "SIGKILL"); killed = true; }
    }
    await exited;
    const beforeKill = ledgerOf(crashed).calls;
    let resumed = null, error = null;
    try { resumed = await finish(system, crashed); } catch (e) { error = e.message; }
    const total = ledgerOf(crashed);
    result[system] = {
      referenceCalls: ledgerOf(reference).calls, killed, callsBeforeKill: beforeKill, callsAfterRestart: total.calls - beforeKill,
      totalCalls: total.calls, extraCalls: total.calls - ledgerOf(reference).calls,
      referenceTokens: ledgerOf(reference).tokens, totalTokens: total.tokens,
      sameChampion: resumed ? JSON.stringify(resumed.champion) === JSON.stringify(clean.champion) : null,
      sameTestMean: resumed ? resumed.test.champion.mean === clean.test.champion.mean : null,
      restartError: error,
    };
    console.error(system, JSON.stringify(result[system]));
  }
} finally { await proxy.close(); }
writeFileSync(resolve(directory, "crash.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
