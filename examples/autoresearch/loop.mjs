// A Karpathy-style autoresearch loop on a real task, then one Mutara gate as the final audit.
//
//   node examples/autoresearch/loop.mjs TASK NEW_RUN_DIRECTORY [--proposals 20] [--proposer llm|claude|noop|replace:FILE] [--model ID] [--effort medium] [--rule naive|seq|naive-pool]
//
// TASK is perf, lunar or rag (see tasks/). Each step a proposer edits one file in RUN/work.
// The loop, not the agent, runs the guard and the validation: keep the commit if validation
// beats the best so far, otherwise revert (autoresearch program.md). After the last step,
// `gate` compares the champion with the starting file on fresh cases the loop never scored.
//
//   llm     (default) an OpenAI-compatible chat model rewrites the file from its content and the
//           step history. MUTARA_LLM_API_KEY, MUTARA_LLM_BASE_URL (default OpenRouter),
//           --model or MUTARA_LLM_MODEL (default stealth/space-bunny-alpha), --effort sets
//           OpenRouter reasoning effort (default medium: unbounded reasoning used all 32k tokens). Cost in tokens.
//   claude  `claude -p` with Read and Edit of the one file only. No shell, no other files.
//   noop    appends a comment: an A/A control. Every "improvement" it keeps is noise.
//   replace:FILE  copies FILE over the target: a positive control (tasks/*/better.*).
//
// Keep rule (--rule; seq and naive-pool need a task with searchCases, rag only):
//   naive       keep if validation beats the best so far (default, autoresearch)
//   seq         Mutara's paired anytime-valid test, champion vs candidate on the search pool in a
//               seeded random order, alpha 0.05, stops when decisive; keep only on accept
//   naive-pool  keep if the mean over the whole search pool beats the best so far
//
// Re-running the same directory resumes after the last logged step; the audit resumes from
// its journal. report.json holds the claimed validation gain next to the audit verdict.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gate, gateDecision } from "teob-mutara/gate";
import { chatClient } from "../reflective-bench/llm.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--proposals", "--proposer", "--model", "--effort", "--rule"];
const [taskName, directory] = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!taskName || !directory) throw new Error("Usage: node examples/autoresearch/loop.mjs perf|lunar|rag RUN_DIRECTORY [options]");
const proposals = Number(flag("--proposals", 20)), proposer = flag("--proposer", "llm");
const model = flag("--model", proposer === "llm" ? process.env.MUTARA_LLM_MODEL ?? "stealth/space-bunny-alpha" : null);
if (proposer === "llm" && !process.env.MUTARA_LLM_API_KEY && !process.env.MUTARA_LLM_BASE_URL) {
  throw new Error("--proposer llm needs MUTARA_LLM_API_KEY (or MUTARA_LLM_BASE_URL for a keyless endpoint); use --proposer claude for claude -p");
}
const task = (await import(`./tasks/${taskName}/task.mjs`)).default;
const rule = flag("--rule", "naive"), SEQ_ALPHA = 0.05;
if (!["naive", "seq", "naive-pool"].includes(rule)) throw new Error(`unknown --rule ${rule}`);
if (rule !== "naive" && !task.searchCases) throw new Error(`--rule ${rule} needs a task with searchCases`);

const run = resolve(directory), work = join(run, "work"), file = join(work, task.file), logPath = join(run, "log.jsonl");
const git = (...a) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" }).trim();
const commit = (message) => git("-c", "user.name=autoresearch", "-c", "user.email=autoresearch@localhost", "commit", "-qam", message);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const log = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const record = (entry) => { log.push(entry); appendFileSync(logPath, JSON.stringify(entry) + "\n"); console.error(JSON.stringify(entry)); };

// One process per run directory: a second copy would interleave steps in the same log and repo.
mkdirSync(run, { recursive: true });
const lockPath = join(run, "lock");
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, "utf8"));
  const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  if (alive) throw new Error(`${run} is already used by process ${pid}`);
}
writeFileSync(lockPath, String(process.pid));
process.on("exit", () => { if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) rmSync(lockPath); });

if (!existsSync(work)) {
  mkdirSync(work, { recursive: true });
  copyFileSync(task.initial, file);
  git("init", "-q");
  git("add", task.file);
  commit("start");
  git("tag", "start");
}
const start = git("rev-parse", "start");
const championFile = join(run, `champion${task.file.slice(task.file.lastIndexOf("."))}`);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Seeded shuffle, so a resumed step tests the pool in the same order.
const shuffled = (ids, seed) => {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
// One keep decision for the edited file against the current champion.
async function judge(step) {
  if (rule === "naive") return { ...(await task.validate(file)), evaluations: task.validationSize ?? null };
  writeFileSync(championFile, git("show", `HEAD:${task.file}`) + "\n");
  const ids = shuffled(task.searchCases, step);
  const scores = await task.compare(championFile, file, ids);
  const candidate = mean(ids.map((id) => scores.get(id).candidate));
  if (rule === "naive-pool") return { score: candidate, evaluations: ids.length };
  const decision = gateDecision(ids.map((id) => scores.get(id).candidate - scores.get(id).baseline), { scoreRange: 1, minimumGain: 0, alpha: SEQ_ALPHA });
  const pairs = Number(/n=(\d+)/.exec(decision.reason)[1]);
  return { score: candidate, accepted: decision.accepted, reason: decision.reason, evaluations: 2 * pairs };
}
if (!log.length) {
  const base = rule === "naive" ? await task.validate(file)
    : { score: mean([...(await task.compare(task.initial, file, task.searchCases)).values()].map((s) => s.candidate)) };
  record({ step: 0, status: "baseline", rule, ...base });
}
if (git("status", "--porcelain", "--", task.file)) git("checkout", "--", task.file); // a step interrupted before it was logged
let best = Math.max(...log.filter((e) => e.status === "baseline" || e.status === "keep").map((e) => e.score));

const prompt = () => `You are one step of an autoresearch loop. ${task.goal}

Change only ${task.file}. The loop runs the guard and the validation after you finish. Make one
focused change that you expect to raise the validation score (higher is better). Current best: ${best}.

${{ naive: "", seq: "A change is kept only if a paired statistical test on 779 judged claims shows it beats the current best; score is its mean nDCG@10 on those claims.\n\n",
  "naive-pool": "Scores are mean nDCG@10 over 779 judged claims.\n\n" }[rule]}Previous steps (score is the validation score; reverted steps are gone from the file):
${log.slice(1).map((e) => `${e.step}\t${e.status}\t${e.score ?? ""}\t${e.description ?? ""}${e.error ? `\t${e.error}` : ""}`).join("\n") || "none"}

${proposer === "llm" ? `Current ${task.file}:
\`\`\`
${readFileSync(file, "utf8")}\`\`\`

Reply with one line describing your change, then the complete new ${task.file} in one fenced code block.` : `Use only Read and Edit on ./${task.file}. Reply with one line describing your change.`}`;
const llm = proposer === "llm" && chatClient({ baseUrl: process.env.MUTARA_LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
  apiKey: process.env.MUTARA_LLM_API_KEY, model, temperature: 0.7, maxTokens: 32_000, timeoutMs: 600_000,
  body: { reasoning: { effort: flag("--effort", "medium") } } });

async function propose(step) {
  if (proposer === "noop") {
    appendFileSync(file, `${task.comment} noop ${step}\n`);
    return { description: "noop comment", cost: 0 };
  }
  if (proposer === "llm") {
    const { text, tokens } = await llm([{ role: "user", content: prompt() }]);
    const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (blocks.length) writeFileSync(file, blocks.at(-1)[1]);
    const description = text.split("\n").find((l) => l.trim() && !l.startsWith("```")) ?? "";
    return { description: blocks.length ? description.trim().slice(0, 200) : "no code block in reply", cost: tokens };
  }
  if (proposer.startsWith("replace:")) {
    copyFileSync(proposer.slice(8), file);
    return { description: `replaced with ${proposer.slice(8)}`, cost: 0 };
  }
  const out = await new Promise((resolve, reject) => {
    const child = execFile("claude", ["-p", prompt(), ...(model ? ["--model", model] : []), "--output-format", "json",
      "--permission-mode", "dontAsk", "--allowedTools", "Read(./**)", `Edit(./${task.file})`],
    { cwd: work, maxBuffer: 1 << 24, timeout: 15 * 60_000 }, (error, stdout, err) => {
      // claude exits 1 on API errors but still prints its JSON result: report that, not the command line.
      const result = (() => { try { return JSON.parse(stdout); } catch { return null; } })();
      if (result?.is_error || !result) reject(new Error(`claude failed: ${result?.result ?? (err.trim() || error?.message)}`));
      else resolve(result);
    });
    child.stdin.end();
  });
  return { description: String(out.result).trim().split("\n").pop().slice(0, 200), cost: out.total_cost_usd ?? 0 };
}

for (let step = log.length; step <= proposals; step++) {
  const { description, cost } = await propose(step);
  const source = readFileSync(file, "utf8");
  let entry = { step, description, cost };
  if (!git("status", "--porcelain", "--", task.file)) entry.status = "no-change";
  else if (task.forbidden.test(source)) entry.status = "forbidden";
  else {
    try {
      entry = { ...entry, ...(await judge(step)) };
      entry.status = (rule === "seq" ? entry.accepted : entry.score > best) ? "keep" : "discard";
    } catch (error) {
      entry = { ...entry, status: "crash", error: String(error.message).slice(0, 300) };
    }
  }
  if (entry.status === "keep") {
    best = entry.score; // seq: the champion's pool mean, shown to the proposer
    commit(`step ${step}: ${description}`);
  } else git("checkout", "--", task.file);
  record(entry);
}

// Final audit: champion against the starting file on fresh cases, paired, one gate.
const head = git("rev-parse", "HEAD");
const auditDir = join(run, "audit");
mkdirSync(auditDir, { recursive: true });
const [base, champion] = [start, head].map((rev, i) => {
  const path = join(auditDir, `${i ? "champion" : "start"}${task.file.slice(task.file.lastIndexOf("."))}`);
  writeFileSync(path, git("show", `${rev}:${task.file}`) + "\n");
  return path;
});
const scores = await task.audit(base, champion, task.freshCases);
const cases = task.freshCases.map((id) => ({ id: String(id), input: null }));
const audit = await gate({
  id: `autoresearch-${taskName}-audit-${head.slice(0, 12)}`, storage: join(run, "audit.db"),
  implementation: { task: taskName, start: sha256(readFileSync(base)), champion: sha256(readFileSync(champion)), harness: task.harness },
  cases,
  baseline: async (c) => ({ output: scores.get(c.id).baseline, cost: 0 }),
  candidate: async (c) => ({ output: scores.get(c.id).candidate, cost: 0 }),
  score: (output) => ({ score: output }),
  scoreRange: 1,
});
const freshMean = (key) => [...scores.values()].reduce((a, s) => a + s[key], 0) / scores.size;
const steps = log.slice(1);
const report = {
  task: taskName, rule, proposer, model: proposer === "llm" || proposer === "claude" ? model ?? "claude default" : null,
  effort: proposer === "llm" ? flag("--effort", "medium") : null, proposals: steps.length,
  statuses: Object.fromEntries(["keep", "discard", "crash", "forbidden", "no-change"].map((s) => [s, steps.filter((e) => e.status === s).length])),
  evaluations: steps.reduce((a, e) => a + (e.evaluations ?? 0), 0),
  proposerCost: { total: steps.reduce((a, e) => a + (e.cost ?? 0), 0), unit: proposer === "claude" ? "USD" : "tokens" },
  validation: { start: log[0].score, best, claimedGain: best - log[0].score, unit: task.unit },
  fresh: { cases: scores.size, start: freshMean("baseline"), champion: freshMean("candidate"), metric: task.auditMetric },
  audit: { verdict: audit.verdict, cases: audit.cases, reason: audit.reason },
  changed: start !== head,
};
writeFileSync(join(run, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
