# Mutara

**Make your AI workflow better or cheaper — and ship the change only when fresh data says so.**

Give Mutara what to improve, examples, and a scorer. It studies failures,
rewrites the candidate, and keeps it only when it wins on data it never
trained on. Prompts, numeric settings, agent strategies, routing rules —
same engine.

- **Self-improving** — reads failures and scorer feedback, rewrites the candidate itself
- **Safe** — new version promoted only if it also wins on validation cases the rewriter never saw, and breaks no hard rule
- **Tested** — final version vs. original on fresh cases with an anytime-valid significance test
- **Ship gate** — `gate` checks a new prompt or a cheaper model against production: promote, reject or inconclusive, in code or CI
- **Resilient** — crash or rate limit: resumes at the exact step, no repeated paid calls

Payment-extraction prompt **68 → 99–100%** in 1–2 rounds.
Lunar Lander in wind **51–64 → 78–95%** landings.
Negative results shown too. [Measured results ↓](#measured-results)

## Quick start

Node.js 22+. `pnpm add teob-mutara`

```js
import { optimizeReflective, buildReflectionPrompt } from "teob-mutara/reflective";

const result = await optimizeReflective({
  id: "support-router-v1",           // same ID after crash = resume
  storage: "./mutara.db",
  initialPrompt: "Classify the support message.",
  objective: "Route refund requests correctly without breaking other intents.",
  cases: [ /* { id, split: "train"|"validation", input, expected } */ ],
  finalCases: [ /* fresh, used only for the significance test */ ],

  run: async (prompt, c) => {
    const r = await llm({ system: prompt, user: c.input.text });
    return { output: r.text, cost: r.tokens };
  },
  score: (receipt, c) => ({
    score: Number(receipt.output === c.expected),
    feedback: receipt.output !== c.expected ? `expected ${c.expected}` : undefined,
  }),
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const r = await llm({ user: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) });
    return { text: r.text, cost: r.tokens };
  },

  rounds: 8,
  budget: { cost: 2_000_000 },
});

console.log(result.champion);   // best proven prompt
console.log(result.finalAudit); // original vs. best, significance test verdict
```

Full options: [reflective.md](skills/mutara/references/reflective.md).
Try locally without API keys: `pnpm demo` / `pnpm demo:reflective`.

## Ship gate: cheaper model, same quality?

```js
import { gate } from "teob-mutara/gate";

const { verdict } = await gate({
  id: "extract-big-to-small-v1", storage: "./mutara.db", implementation: { prompt, scorer: "fields-v2" },
  cases: freshCases,                       // never used for tuning
  baseline: (c) => extract(bigModel, prompt, c),
  candidate: (c) => extract(smallModel, tunedPrompt, c),
  score: (output, c) => ({ score: fieldsCorrect(output, c.expected) }),
  scoreRange: 1,
  minimumGain: -0.03,                      // at most 3 points worse
});
// "promote" | "reject" | "inconclusive"
```

Stops as soon as the result is decisive, so clear cases are cheap. In CI:
`npx teob-mutara gate gate.config.mjs` (exit 0/1/3) or the bundled GitHub Action.
Details and sample sizes: [gate.md](skills/mutara/references/gate.md). Worked example:
[cost-down](examples/cost-down/).

## What Mutara fits

Mutara runs the loop when a candidate fits in one value it can store and replay: text,
JSON parameters, or a self-contained function.

| Candidate | Example | API |
|---|---|---|
| System or agent prompt | Extraction prompt that learns format rules from failures ([reflective-bench](examples/reflective-bench/)); tool-calling agent that learns which tool to call ([vercel-ai](examples/vercel-ai/)) | `optimizeReflective` |
| Several prompt parts | Planner and answerer prompts, tool descriptions, few-shot blocks improved together | `optimizeReflective` (components) |
| Numeric settings | Controller constants ([lunar](examples/lunar/)); RAG top-k, score threshold; temperature | `optimize` |
| Fixed variants | A few hand-written prompts, pick the best ([prompt-gate](examples/prompt-gate/)) | `optimize` or `Adapter` |
| Self-contained function | Router with a hard rule (`violation`), ranking `(query, docs) => ids`, parser; run in a sandbox | `optimizeReflective` |
| Your own search | CFR, evolution, an external generator | `Adapter` + `learnerHarness` |

Mutara judges once when the change already exists and the question is whether to ship it.

| Decision | Example | API |
|---|---|---|
| Cheaper model, same quality | Expensive vs cheap model with a tuned prompt ([cost-down](examples/cost-down/)) | `gate` with negative `minimumGain` |
| New prompt vs production | Against logged production inputs, no live traffic ([shadow](examples/shadow/)) | `gate` |
| Optimizer champion | Champion vs the original on fresh cases | `finalAudit` or `gate` |
| Overnight agent loop result | Champion commit vs start commit of an autoresearch-style loop | `gate` |
| Change in CI | Block a merge that drops quality | `npx teob-mutara gate`, GitHub Action |

Not a fit:

- An agent editing many files and keeping state in git. Let the agent run the loop and
  audit the result with one `gate`.
- A faster keep/discard rule for such loops. At equal budget, gating every step found less
  than naive keep/discard ([lessons](examples/LESSONS.md#agent-loops-autoresearch)).
- One expensive run that returns one number, such as a 5-minute GPU training run: `gate`
  needs per-case scores.
- Tasks without a reliable score. Build a small evaluation set first.
- Training model weights.

Adapter template: [skills/mutara/assets/adapter.mjs](skills/mutara/assets/adapter.mjs).

## Measured results

Every number on held-out cases never used to pick the winner. Each example's
README has method, raw numbers, and negative results.

**Prompts** — [reflective-bench](examples/reflective-bench/): extract payment
fields. Format rules the initial prompt never states; learned only from failures.

| Run | 60 unseen cases | Rounds | Tokens |
|---|---|---|---|
| 1 | 68 → 99% (significant) | 2 | 121k |
| 2 | 68 → 100% (significant) | 1 | 86k |

**Strategies** — [Lunar Lander in wind](examples/lunar/): 10 controller
constants, 51–64 → 78–95% solved (3 seeds, 200 episodes each).

**What didn't work** — [LESSONS.md](examples/LESSONS.md),
[gate negative result](examples/lunar/#gate-vs-ungated-negative-result).

## How it compares

The search is simple on purpose; GEPA (which Mutara's reflective mode
follows), DSPy and Ax search well too, and GEPA also resumes from checkpoints.
What Mutara adds is the decision around the search: hard rules can't be traded
for score, the final gain or parity is a significance test on fresh cases with
a promote / reject / inconclusive verdict, every paid call is journaled once,
and it runs in TypeScript and CI. Plug a stronger search in through `Adapter`
and keep the rest.

## Agent skill

[skills/mutara/SKILL.md](skills/mutara/SKILL.md) — teaches a coding agent to
wire Mutara into your project. Ships in the npm package.

## References

[API](skills/mutara/references/api.md) ·
[optimizer](skills/mutara/references/optimizer.md) ·
[reflective](skills/mutara/references/reflective.md) ·
[gate](skills/mutara/references/gate.md) ·
[evaluation](skills/mutara/references/evaluation.md) ·
[recovery](skills/mutara/references/operations.md)

## Limitations

- Search is basic — plug a stronger generator via `Adapter` for hard spaces.
- Validation set reused each round; report gains from the final check only.
- Budget enforced on reported costs; your runner limits its own spending.
- Experiments in SQLite. No API keys in `implementation` or case data.
- Resume requires same package version and task code. No auto-migration.
- Not a faster search for agent loops: at equal budget, gating every step found less than naive keep/discard ([lessons](examples/LESSONS.md#agent-loops-autoresearch)). Use one gate at the end to check the loop's claimed gain.
