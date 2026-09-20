// Test the distributable in a clean application, without the repository's node_modules.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
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
  const installed = join(directory, "node_modules/mutara");
  const files = readdirSync(installed, { recursive: true }).map(String);
  assert(!files.some((name) => /(^|[/\\])(?:\.env(?:\..*)?|data|AGENT-JOURNAL-HYPOTHESIS\.md)(?:[/\\]|$)/.test(name)));
  assert(!files.some((name) => name.startsWith("examples/alchemy")));
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@lambda-house/teob-ts"], "0.4.2");
  assert(files.includes("skills/mutara/SKILL.md"));
  copyFileSync(join(installed, "skills/mutara/assets/adapter.mjs"), join(directory, "adapter.mjs"));
  const demo = readFileSync(join(installed, "examples/minimal.mjs"), "utf8")
    .replace("../skills/mutara/assets/adapter.mjs", "./adapter.mjs");
  writeFileSync(join(directory, "demo.mjs"), demo);
  console.log(run(process.execPath, ["demo.mjs"]).trim());
  writeFileSync(join(directory, "consumer.ts"), `import { learnerHarness, version, digest, type Adapter, type BasePlan } from "mutara";
const initial = version({ threshold: 0.5 }, digest({ task: "consumer" }));
type Plan = BasePlan<typeof initial>;
export function connect(adapter: Adapter<typeof initial, Plan, number>) {
  return learnerHarness(":memory:", adapter);
}
`);
  run(process.execPath, [join(directory, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--allowJs", "--checkJs", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts", "adapter.mjs"]);
  console.log("PASS: clean install, copied adapter, real learning loop, TypeScript exports, and package contents.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
