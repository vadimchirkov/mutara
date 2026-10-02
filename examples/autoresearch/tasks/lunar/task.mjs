// Lunar: land in a storm. Validation: share of 100 fixed seeds solved (return >= 200).
// Audit: fresh seeds; both controllers fly the same seed, a case scores 1 when solved.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const here = (f) => new URL(f, import.meta.url).pathname;
// LUNAR_PYTHON=/path/to/python with gymnasium[box2d] skips uv, as in examples/lunar.
const [command, ...prefix] = process.env.LUNAR_PYTHON ? [process.env.LUNAR_PYTHON] :
  ["uv", "run", "-q", "--python", "3.12", "--with", "gymnasium[box2d]==1.3.0", "--with", "numpy==2.5.3", "python"];
function episodes(controller, seeds) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...prefix, here("episodes.py"), controller], { maxBuffer: 1 << 24, timeout: 900_000 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || error.message)) : resolve(JSON.parse(stdout))));
    child.stdin.end(JSON.stringify({ seeds }));
  });
}
const solved = (r) => (r >= 200 ? 1 : 0);
const VALIDATION = Array.from({ length: 100 }, (_, i) => i);

export default {
  file: "controller.py",
  initial: here("controller.py"),
  comment: "#",
  goal: "The task: improve act() in controller.py, the controller of Gymnasium's LunarLander-v3 (continuous actions) in strong wind (wind_power 20, turbulence 1.5). An episode is solved when its return is at least 200. The validation score is the share of 100 fixed seeds solved. Only numpy and the standard math module are available; the controller must be a pure function of the observation.",
  unit: "solved share",
  auditMetric: "solved share on fresh seeds",
  // Pure controller: numpy and math only, no files, processes or access to the environment.
  forbidden: /\bimport\s+(?!numpy\b|math\b)\w|\bfrom\s+(?!numpy\b|math\b)\w|\bopen\s*\(|__import__|\beval\s*\(|\bexec\s*\(|\bgym/,
  harness: createHash("sha256").update(readFileSync(here("episodes.py"))).digest("hex"),
  freshCases: Array.from({ length: 300 }, (_, i) => String(100_000 + i)),
  validate: async (file) => {
    const r = Object.values(await episodes(file, VALIDATION));
    return { score: r.filter((x) => x >= 200).length / r.length };
  },
  audit: async (start, champion, ids) => {
    const seeds = ids.map(Number);
    const [a, b] = await Promise.all([episodes(start, seeds), episodes(champion, seeds)]);
    return new Map(ids.map((id) => [id, { baseline: solved(a[id]), candidate: solved(b[id]) }]));
  },
};
