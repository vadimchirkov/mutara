// Test the distributable in a clean application, without the repository's node_modules.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "mutara-consumer-"));
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error ?? result.stdout + result.stderr}`);
  return result.stdout;
}
try {
  const archive = join(directory, "mutara.tgz");
  run("pnpm", ["pack", "--out", archive], root);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", archive, "typescript@5.7.3", "@types/node@22"]);
  const installed = join(directory, "node_modules/teob-mutara");
  const files = readdirSync(installed, { recursive: true }).map(String);
  assert(!files.some((name) => /(^|[/\\])(?:\.env(?:\..*)?|data|AGENT-JOURNAL-HYPOTHESIS\.md)(?:[/\\]|$)/.test(name)));
  assert(!files.some((name) => name.startsWith("examples/alchemy")));
  assert(!files.some((name) => name.startsWith("examples/crypto-paper")));
  assert(!files.some((name) => /\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal))?$/.test(name)));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@lambda-house/teob-ts"], "0.4.2");
  assert(files.includes("skills/mutara/SKILL.md"));
  copyFileSync(join(installed, "skills/mutara/assets/adapter.mjs"), join(directory, "adapter.mjs"));
  const demo = readFileSync(join(installed, "examples/minimal.mjs"), "utf8")
    .replace("../skills/mutara/assets/adapter.mjs", "./adapter.mjs");
  writeFileSync(join(directory, "demo.mjs"), demo);
  console.log(run(process.execPath, ["demo.mjs"]).trim());
  cpSync(join(installed, "examples/prompt-gate"), join(directory, "prompt-gate"), { recursive: true });
  const promptArgs = ["prompt-gate/run.mjs", "./prompt-gate.db", "package-prompt-gate-v1"];
  const promptReport = JSON.parse(run(process.execPath, promptArgs));
  assert.deepEqual(promptReport.accepted, [false, true]);
  assert.equal(promptReport.finalTest[0].candidate.accuracy, 0.25);
  assert.equal(promptReport.finalTest[1].candidate.accuracy, 0.875);
  assert.deepEqual(JSON.parse(run(process.execPath, promptArgs)), promptReport);
  writeFileSync(join(directory, "consumer.ts"), `import { version, digest, type Adapter, type BasePlan } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { optimize, createOptimizer } from "teob-mutara/optimizer";
export { optimize, createOptimizer };
const initial = version({ threshold: 0.5 }, digest({ task: "consumer" }));
type Plan = BasePlan<typeof initial>;
export function connect(adapter: Adapter<typeof initial, Plan, number>) {
  return learnerHarness(":memory:", adapter);
}
`);
  run(process.execPath, [join(directory, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--allowJs", "--checkJs", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts", "adapter.mjs"]);
  writeFileSync(join(directory, "optimizer.mjs"), `import assert from "node:assert/strict";
import { optimize } from "teob-mutara/optimizer";
let calls = 0;
const options = {
  id: "package-smoke", storage: "./optimizer.db",
  implementation: { task: "package-smoke-v1" },
  space: { x: { type: "float", min: 0, max: 1, initial: 0.5 } },
  metrics: [{ name: "score", direction: "higher", weight: 1 }],
  execute: async ({ x }) => { calls++; return { output: { score: x }, cost: 0 }; },
  decision: { mode: "heuristic" }, recovery: "repeatable", budget: { trials: 2 },
};
const result = await optimize(options);
assert.equal(result.executions, 4);
assert.deepEqual(await optimize(options), result);
assert.equal(calls, 4);
`);
  run(process.execPath, ["optimizer.mjs"]);
  console.log("PASS: clean install, copied adapters, prompt gate + final audit replay, TypeScript exports, and package contents.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
