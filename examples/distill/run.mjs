// Amplify, then distill: the same model with reasoning and a 5-sample vote is the teacher;
// one plain call with a prompt tuned to agree with the teacher is the student. True answers
// are never used in tuning, only by the gates on fresh cases. Criteria: README.md.
//
//   MUTARA_LLM_BASE_URL=... MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... [TEACHER_MODEL=...] [STUDENT_MODEL=...] \
//     node examples/distill/run.mjs NEW_REPORT_DIRECTORY [--margin 0.03] [--rounds 8] [--concurrency 4] [--dry]
//
// Re-running with the same directory resumes from the journal without repeating finished calls.
// `--dry` swaps every model for a scripted stub: it checks wiring and measures nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest, version, validateVersion } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { gate } from "teob-mutara/gate";
import { buildReflectionPrompt, optimizeReflective } from "teob-mutara/reflective";
import { chatClient } from "../reflective-bench/llm.mjs";
import { OBJECTIVE, dataset, grade, makeCase, parseReply } from "../reflective-bench/task.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--margin", "--rounds", "--concurrency"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/distill/run.mjs NEW_REPORT_DIRECTORY [options]");
const dry = args.includes("--dry");
const margin = Number(flag("--margin", 0.03)), rounds = Number(flag("--rounds", 8)), concurrency = Number(flag("--concurrency", 4));

// cost-down's production prompt: states the easy conventions, not the hard business rules.
const PRODUCTION_PROMPT = `Extract the payment from the message. Reply with only a JSON object with string fields:
- amount: two decimals ("12.50"), no decimals for JPY; negative for refunds
- currency: ISO 4217 code
- date: ISO 8601 (YYYY-MM-DD)
- vendor: upper case, without legal suffix (Ltd, LLC, Inc., GmbH, plc, AG)`;
const TEACHER_PROMPT = PRODUCTION_PROMPT.replace("Reply with only a JSON object",
  "First reason step by step about what the message really says was paid, by whom and when. Then end your reply with a JSON object");
const SAMPLES = 5;
const FIELDS = ["amount", "currency", "date", "vendor"];

const { cases } = dataset("hard");
const fresh = Array.from({ length: 300 }, (_, i) => ({ id: `fresh-${i}`, ...makeCase(5000 + i, "hard") }));
const byText = new Map([...cases, ...fresh].map((c) => [c.input.text, c.expected]));

const env = process.env;
const models = dry ? { teacher: "dry-teacher", student: "dry-student" }
  : { teacher: env.TEACHER_MODEL || env.MUTARA_LLM_MODEL, student: env.STUDENT_MODEL || env.MUTARA_LLM_MODEL };
// Stub: one teacher sample is right 80% of the time, so the vote is right ~94%; the student
// 85%, or 97% once the prompt says "Be precise."
const share = (text) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000, 7) / 1000;
let sample = 0;
const stub = (role) => async (messages) => {
  if (role === "reflect") return { text: `${messages[0].content.match(/<prompt>\n([\s\S]*?)\n<\/prompt>/)[1]} Be precise.`, tokens: 50, ms: 0 };
  const expected = byText.get(messages[1].content);
  const rate = role === "teacher" ? 0.8 : messages[0].content.includes("Be precise.") ? 0.97 : 0.85;
  const draw = role === "teacher" ? share(messages[1].content + sample++) : share(messages[1].content);
  return { text: JSON.stringify(draw < rate ? expected : { ...expected, vendor: "?" }), tokens: role === "teacher" ? 400 : 100, ms: 0 };
};
const client = (role, model, temperature, maxTokens) => dry ? stub(role)
  : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model, temperature, maxTokens });
const llm = {
  teacher: client("teacher", models.teacher, 0.7, 3000),
  student: client("student", models.student, 0, 2000),
  reflect: client("reflect", models.teacher, 0.7, 8000),
};

// Field-wise majority over the samples that parsed; ties go to the earliest sample.
function vote(replies) {
  const parsed = replies.map(parseReply).filter(Boolean);
  const out = {};
  for (const f of FIELDS) {
    const values = parsed.filter((p) => p[f] !== undefined && p[f] !== null).map((p) => String(p[f]));
    if (!values.length) continue;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    out[f] = values.reduce((best, v) => (counts.get(v) > counts.get(best) ? v : best), values[0]);
  }
  return out;
}
async function teach(text) {
  const replies = [];
  let tokens = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const r = await llm.teacher([{ role: "system", content: TEACHER_PROMPT }, { role: "user", content: text }]);
    replies.push(r.text);
    tokens += r.tokens;
  }
  return { output: JSON.stringify(vote(replies)), cost: tokens };
}
const student = (prompt) => async (c) => {
  const r = await llm.student([{ role: "system", content: prompt }, { role: "user", content: c.input.text }]);
  return { output: r.text, cost: r.tokens };
};

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const implementation = { run: source("run.mjs"), task: source("../reflective-bench/task.mjs"), llm: source("../reflective-bench/llm.mjs"), models, samples: SAMPLES };
const storage = join(resolve(directory), "distill.db");
const tag = `${models.teacher}-to-${models.student}`;
mkdirSync(resolve(directory), { recursive: true });

// 1. Teacher outputs, once, journaled: one job per case, one round, nothing to accept.
const labelImplementation = { ...implementation, role: "teacher-labels-v1", prompt: TEACHER_PROMPT };
const labelImplId = digest(labelImplementation);
const toLabel = [...cases, ...fresh].map((c) => ({ id: c.id, text: c.input.text }));
const COST_LIMIT = SAMPLES * 5000;
const labeler = learnerHarness(storage, {
  implementation: labelImplementation,
  recovery: "repeatable",
  validatePlan: () => {},
  validateVersion: (v) => validateVersion(v, labelImplId),
  limits: (p) => ({ executions: p.cases.length, cost: p.cases.length * COST_LIMIT }),
  propose: (champion) => version(champion.config, labelImplId, champion.id),
  jobs: (_champion, _candidate, p) => p.cases.map((c) => ({ key: c.id, input: c.text, costLimit: COST_LIMIT })),
  execute: async (job) => teach(job.input),
  grade: (_job, receipt) => ({ metrics: {}, data: null }),
  assess: (runs) => ({ evaluation: Object.fromEntries(runs.map((r) => [r.job.key, r.receipt])), decision: { accepted: false, reason: "labels only" } }),
}, { concurrency });
let labels;
try {
  const id = `distill-${tag}-labels-v1`;
  await labeler.startOrResume(id, { initial: version({ prompt: TEACHER_PROMPT }, labelImplId), rounds: 1, cases: toLabel });
  // Like optimizeReflective's runner: a blocked job is retried, at most 3 times per run.
  for (let attempt = 0; !labels; attempt++) {
    try {
      labels = (await labeler.wait(id)).trials[0].evaluation;
    } catch (error) {
      const s = await labeler.state(id);
      if (s.status !== "blocked" || !s.unresolved?.length || attempt >= 3) throw error;
      for (const jobId of s.unresolved) await labeler.send(id, { tag: "retry", jobId });
    }
  }
} finally {
  await labeler.close();
}
const labelOf = (c) => JSON.parse(labels[c.id].output);

// 2. Tune the student on teacher votes only. Cases without a full vote are dropped.
const taught = cases.filter((c) => FIELDS.every((f) => f in labelOf(c))).map((c) => ({ ...c, expected: labelOf(c) }));
const tuned = await optimizeReflective({
  id: `distill-${tag}-tune-v1`, storage, implementation, concurrency,
  initialPrompt: PRODUCTION_PROMPT, objective: OBJECTIVE, cases: taught,
  run: async (prompt, c) => student(prompt)(c),
  score: (receipt, c) => grade(receipt.output, c.expected),
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const reply = await llm.reflect([{ role: "user", content: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) }]);
    return { text: reply.text.replace(/^```\w*\n?|\n?```$/g, "").trim(), cost: reply.tokens };
  },
  rounds, maxPromptChars: 6000, recovery: "repeatable",
  costLimit: 10_000, reflectionCostLimit: 20_000, budget: { cost: 3_000_000 },
});

// 3. Gate both students against the journaled teacher on fresh cases, scored against the truth.
const score = (output, c) => { const g = grade(output, c.expected); return { score: g.score, violation: g.violation }; };
const arm = (name, prompt) => gate({
  id: `distill-${tag}-${name}-m${margin}-v1`, storage, implementation: { ...implementation, prompt }, cases: fresh,
  baseline: async (c) => labels[c.id], candidate: student(prompt),
  score, scoreRange: 1, minimumGain: -margin, concurrency, costLimit: COST_LIMIT,
});
const naive = await arm("naive", PRODUCTION_PROMPT);
const distilled = await arm("distilled", tuned.champion);

const ratio = (r) => r.candidate.cost / r.baseline.cost;
const agreement = (list) => list.reduce((a, c) => a + grade(labels[c.id].output, c.expected).score, 0) / list.length;
const report = {
  note: dry ? "Dry run with scripted stubs: wiring only, not a measurement." : "One run on generated cases; criteria in examples/distill/README.md.",
  models, samples: SAMPLES, margin,
  teacherLabelAccuracy: { trainValidation: agreement(cases), fresh: agreement(fresh) },
  taughtCases: taught.length,
  tuning: { rounds: tuned.roundsCompleted, accepted: tuned.history.filter((h) => h.accepted).length, spent: tuned.spent, stopReason: tuned.stopReason },
  naive: { ...naive, costRatio: ratio(naive) },
  distilled: { ...distilled, costRatio: ratio(distilled) },
  criteria: {
    amplificationMatters: naive.verdict !== "promote",
    distilledPromoted: distilled.verdict === "promote",
    cheapEnough: ratio(distilled) <= 1 / 3,
  },
  champion: tuned.champion,
};
report.criteria.pass = Object.values(report.criteria).every(Boolean);
writeFileSync(join(resolve(directory), "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, champion: undefined }, null, 2));
