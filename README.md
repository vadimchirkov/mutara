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

## Beyond prompts

| You have | Use |
|---|---|
| Prompt + scored examples | `optimizeReflective` — `teob-mutara/reflective` |
| Numeric settings or fixed variants | `optimize` — `teob-mutara/optimizer` |
| A change to ship or not (new prompt, cheaper model) | `gate` — `teob-mutara/gate` |
| Your own candidate source | `Adapter` + `learnerHarness` — `teob-mutara` |

Examples: [prompt-gate](examples/prompt-gate/) (fixed candidates, validation gate),
[shadow](examples/shadow/) (test against production logs, no live traffic),
[adapter template](skills/mutara/assets/adapter.mjs).

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
