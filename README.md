# Mutara

**Anything you can run and score gets better on its own — and you can prove it.**

Prompts, strategies, numeric settings, routing rules. Give Mutara the thing to
improve, examples, and a scorer. It finds failures, rewrites the candidate,
and keeps it only if it wins on data it never trained on.

**Self-improving.** For prompts, it reads failures and your scorer's feedback,
then rewrites the prompt itself. No hand-tweaking.

**Safe.** A new version replaces the current one only if it wins on unseen data
and breaks no hard rule. Overfitting is caught, not shipped.

**Provable.** The final version is tested against the original on fresh cases
with a significance test. A number, not a hunch.

**Resilient.** Crash, rate limit, restart — resumes at the exact step. Finished
work is never paid twice. Every decision on record.

On held-out cases: payment-extraction prompt **68 → 99–100%** in 1–2 rounds;
Lunar Lander in wind **51–64 → 78–95%** landings.
[Details and negative results ↓](#measured-results)

## Quick start

Node.js 22+. `pnpm add teob-mutara`

```js
import { optimizeReflective, buildReflectionPrompt } from "teob-mutara/reflective";

const result = await optimizeReflective({
  id: "support-router-v1",
  storage: "./mutara.db",
  implementation: { model: "my-model", scorer: "labels-v1" },
  initialPrompt: "Classify the support message.",
  objective: "Route refund requests correctly without breaking other intents.",
  cases: [
    { id: "t1", split: "train", input: { text: "I want my money back" }, expected: "refund" },
    { id: "v1", split: "validation", input: { text: "Where is my order?" }, expected: "shipping" },
  ],
  finalCases: [/* fresh cases for the final significance test */],
  finalTest: { scoreRange: 1 },

  run: async (prompt, c) => {
    const reply = await llm({ system: prompt, user: c.input.text });
    return { output: reply.text, cost: reply.tokens };
  },
  score: (receipt, c) => ({
    score: Number(receipt.output === c.expected),
    violation: 0,
    feedback: receipt.output === c.expected ? undefined : `expected ${c.expected}`,
  }),
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const reply = await llm({ user: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) });
    return { text: reply.text, cost: reply.tokens };
  },

  rounds: 8,
  costLimit: 4000, reflectionCostLimit: 16000, // per-call caps; receipts above them block the run
  budget: { cost: 2_000_000 },
});

console.log(result.champion);   // best proven prompt
console.log(result.finalAudit); // original vs. best, with the test verdict
```

Full options: [reflective.md](skills/mutara/references/reflective.md).

Try locally without API keys:

```bash
pnpm install --frozen-lockfile
pnpm demo              # tune a classifier threshold; overfitting is caught
pnpm demo:reflective   # prompt loop with a scripted model (wiring only)
```

## Beyond prompts

| You have | Use |
|---|---|
| A prompt + scored examples | `optimizeReflective` — `teob-mutara/reflective` |
| Numeric settings or fixed variants | `optimize` — `teob-mutara/optimizer` |
| Your own candidate source (GEPA, Optuna, solver, hand-picked list) | `Adapter` + `learnerHarness` — `teob-mutara` |

See also: [prompt-gate](examples/prompt-gate/) (fixed candidates, validation gate),
[shadow](examples/shadow/) (test against production logs without touching live traffic),
[ready-made adapter template](skills/mutara/assets/adapter.mjs).

## Measured results

Every number is on held-out cases never used to pick the winner. Each example's
README has method, raw numbers, and negative results.

**Prompts** — [reflective-bench](examples/reflective-bench/): extract amount,
currency, date and vendor from payment messages. Format rules the initial prompt
never states; the model learns them only from failures.

| Run | Original → best (60 unseen cases) | Rounds | Tokens |
|---|---|---|---|
| 1 | 68% → 99% (significant) | 2 | 121k |
| 2 | 68% → 100% (significant) | 1 | 86k |

**Strategies** — same engine, no library changes:

| Example | What is tuned | Held-out result |
|---|---|---|
| [Lunar Lander in wind](examples/lunar/) | 10 controller constants | 51–64% → 78–95% solved (3 seeds × 200 episodes) |

**What didn't work** — Kuhn poker plateaus with hidden information;
gate vs. no gate gave no quality gain on 10 constants.
[LESSONS.md](examples/LESSONS.md) · [gate negative result](examples/lunar/#gate-vs-ungated-negative-result).

## How it compares

DSPy optimizes prompts but takes the best validation score — no final
significance test, no hard-rule protection. Optuna tunes numbers well but
doesn't generate prompts. Neither survives a crash without repeating paid calls.

Mutara is not the strongest search. Its search is simple on purpose; the value
is the discipline around it — so you know the gain is real and you never lose
work or money getting it. Plug a stronger search in through the `Adapter`.

## Agent skill

[skills/mutara/SKILL.md](skills/mutara/SKILL.md) teaches a coding agent to wire
Mutara into your project (`Use $mutara. Improve the support-routing prompt.`).
Ships in the npm package.

## References

[API](skills/mutara/references/api.md) ·
[optimizer](skills/mutara/references/optimizer.md) ·
[reflective options](skills/mutara/references/reflective.md) ·
[evaluation method](skills/mutara/references/evaluation.md) ·
[recovery and rollback](skills/mutara/references/operations.md)

## Limitations

- Search is basic. For hard spaces, plug a stronger generator via `Adapter`.
- Validation set is reused each round — report gains only from the final check.
- Budget is enforced on reported costs; your runner must limit its own spending.
- Experiments in SQLite. No API keys in `implementation` or case data.
- To resume: keep same package version and task code. No auto-migration.
