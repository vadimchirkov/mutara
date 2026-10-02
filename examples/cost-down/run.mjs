// Cost-down: move a production extraction prompt from an expensive model to a cheap one,
// and ship only if a paired non-inferiority test on fresh cases says the cheap setup is
// at most MARGIN worse.
//
//   MUTARA_LLM_BASE_URL=https://openrouter.ai/api/v1 MUTARA_LLM_API_KEY=... \
//   EXPENSIVE_MODEL=... CHEAP_MODEL=... [REFLECT_MODEL=...] \
//   EXPENSIVE_PRICE=... CHEAP_PRICE=... \
//     node examples/cost-down/run.mjs NEW_REPORT_DIRECTORY [--margin 0.03] [--rounds 8] [--concurrency 4] [--dry]
//
// Prices are USD per 1M tokens (prompt + completion blended); without them cost is in tokens.
// Three arms on the same fresh cases, each against the expensive production setup:
//   naive      cheap model, production prompt unchanged
//   optimized  cheap model, prompt tuned by optimizeReflective on train/validation only
// Re-running with the same directory resumes from the journal without repeating finished calls.
// `--dry` swaps every model for a scripted stub: it checks wiring and measures nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gate } from "teob-mutara/gate";
import { buildReflectionPrompt, optimizeReflective } from "teob-mutara/reflective";
import { chatClient } from "../reflective-bench/llm.mjs";
import { OBJECTIVE, dataset, grade, makeCase } from "../reflective-bench/task.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const valued = ["--margin", "--rounds", "--concurrency"];
const directory = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
if (!directory) throw new Error("Usage: node examples/cost-down/run.mjs NEW_REPORT_DIRECTORY [options]");
const dry = args.includes("--dry");
const margin = Number(flag("--margin", 0.03)), rounds = Number(flag("--rounds", 8)), concurrency = Number(flag("--concurrency", 4));

// The team's current prompt: states the easy conventions, not the hard business rules.
const PRODUCTION_PROMPT = `Extract the payment from the message. Reply with only a JSON object with string fields:
- amount: two decimals ("12.50"), no decimals for JPY; negative for refunds
- currency: ISO 4217 code
- date: ISO 8601 (YYYY-MM-DD)
- vendor: upper case, without legal suffix (Ltd, LLC, Inc., GmbH, plc, AG)`;

const { cases } = dataset("hard");
// Fresh cases for the gate, disjoint from the optimizer's train/validation/final seeds.
const fresh = Array.from({ length: 300 }, (_, i) => ({ id: `fresh-${i}`, ...makeCase(5000 + i, "hard") }));
const byText = new Map([...cases, ...fresh].map((c) => [c.input.text, c.expected]));

const env = process.env;
const models = dry ? { expensive: "dry-expensive", cheap: "dry-cheap", reflect: "dry-reflect" }
  : { expensive: env.EXPENSIVE_MODEL, cheap: env.CHEAP_MODEL, reflect: env.REFLECT_MODEL || env.EXPENSIVE_MODEL };
const price = { expensive: Number(env.EXPENSIVE_PRICE ?? 0), cheap: Number(env.CHEAP_PRICE ?? 0) };
const usd = (tier, tokens) => (price[tier] ? (tokens * price[tier]) / 1e6 : tokens);
// Stub: the expensive model is right 97% of the time; the cheap one 85%, or 97% once the prompt says "Be precise."
const share = (text) => [...text].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000, 7) / 1000;
const stub = (tier) => async (messages) => {
  if (tier === "reflect") return { text: `${messages[0].content.match(/<prompt>\n([\s\S]*?)\n<\/prompt>/)[1]} Be precise.`, tokens: 50, ms: 0 };
  const expected = byText.get(messages[1].content);
  const rate = tier === "expensive" || messages[0].content.includes("Be precise.") ? 0.97 : 0.85;
  return { text: JSON.stringify(share(messages[1].content) < rate ? expected : { ...expected, vendor: "?" }), tokens: 100, ms: 0 };
};
const client = (tier, temperature, maxTokens) => dry ? stub(tier)
  : chatClient({ baseUrl: env.MUTARA_LLM_BASE_URL, apiKey: env.MUTARA_LLM_API_KEY, model: models[tier], temperature, maxTokens });
const llm = { expensive: client("expensive", 0, 2000), cheap: client("cheap", 0, 2000), reflect: client("reflect", 0.7, 8000) };
const extract = (tier, prompt) => async (c) => {
  const reply = await llm[tier]([{ role: "system", content: prompt }, { role: "user", content: c.input.text }]);
  return { output: reply.text, cost: usd(tier, reply.tokens) };
};

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const implementation = { run: source("run.mjs"), task: source("../reflective-bench/task.mjs"), llm: source("../reflective-bench/llm.mjs"), models, price };
const storage = join(resolve(directory), "cost-down.db");
const tag = `${models.expensive}-to-${models.cheap}`;
mkdirSync(resolve(directory), { recursive: true });

// 1. Tune the production prompt for the cheap model on train/validation only.
const tuned = await optimizeReflective({
  id: `cost-down-${tag}-tune-v1`, storage, implementation, concurrency,
  initialPrompt: PRODUCTION_PROMPT, objective: OBJECTIVE, cases,
  run: async (prompt, c) => extract("cheap", prompt)(c),
  score: (receipt, c) => grade(receipt.output, c.expected),
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const reply = await llm.reflect([{ role: "user", content: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) }]);
    return { text: reply.text.replace(/^```\w*\n?|\n?```$/g, "").trim(), cost: usd("expensive", reply.tokens) };
  },
  rounds, maxPromptChars: 6000, recovery: "repeatable",
  // Reservations per call and for the whole tuning run, in the report's cost unit.
  costLimit: usd("cheap", 10_000), reflectionCostLimit: usd("expensive", 20_000), budget: { cost: usd("expensive", 3_000_000) },
});

// 2. Gate both cheap arms against the expensive production setup on the same fresh cases.
const score = (output, c) => { const g = grade(output, c.expected); return { score: g.score, violation: g.violation }; };
const arm = (name, prompt) => gate({
  id: `cost-down-${tag}-${name}-m${margin}-v1`, storage, implementation: { ...implementation, prompt }, cases: fresh,
  baseline: extract("expensive", PRODUCTION_PROMPT), candidate: extract("cheap", prompt),
  score, scoreRange: 1, minimumGain: -margin, concurrency,
});
const naive = await arm("naive", PRODUCTION_PROMPT);
const optimized = await arm("optimized", tuned.champion);

const ratio = (r) => r.candidate.cost / r.baseline.cost;
const report = {
  note: dry ? "Dry run with scripted stubs: wiring only, not a measurement." : "Measured on generated cases; see examples/cost-down/README.md.",
  models, price, margin, costUnit: price.expensive && price.cheap ? "USD" : "tokens",
  tuning: { rounds: tuned.roundsCompleted, accepted: tuned.history.filter((h) => h.accepted).length, spent: tuned.spent, stopReason: tuned.stopReason },
  naive: { ...naive, costRatio: ratio(naive) },
  optimized: { ...optimized, costRatio: ratio(optimized) },
  champion: tuned.champion,
};
writeFileSync(join(resolve(directory), "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, champion: undefined }, null, 2));
