# Mutara

**A universal optimizer: anything you can run and score gets better on its own — and you can prove it.**

Prompts, agent strategies, RAG settings, routing rules, game policies,
controller parameters. Give Mutara the thing to improve, a few dozen examples
and a way to score results. It finds where the current version fails, tries a
better one, and keeps it only if it wins on examples it never trained on.

- **Learns from its own mistakes** — for prompts, it reads the failed cases and
  your scorer's feedback, then rewrites the prompt itself. No hand-tweaking.
- **Never ships a regression** — a new version replaces the current one only if
  it is better on data it was not tuned on and breaks no hard rule.
- **Proves the gain** — the final version is checked against the original on
  fresh cases with a significance test. A number you can show, not a hunch.
- **Never pays twice** — crash, rate limit or restart: it resumes where it
  stopped, without repeating paid calls. Every decision is on record.

Measured on held-out cases: payment-extraction prompt **68% → 99–100%**
correct in 1–2 rounds; Lunar Lander in wind **51–64% → 78–95%** landings
([details](#measured-results)).

```text
your version ──► run on examples ──► score ──► study failures ──► new version
                                                                     │
      keep it only if it wins on unseen examples  ◄──────────────────┘
                     │
      every step saved: stop anytime, resume without paying again
```

## Quick start

Requires Node.js 22+.

```bash
pnpm add teob-mutara
```

```js
import { optimizeReflective, buildReflectionPrompt } from "teob-mutara/reflective";

// llm() is your model call: returns { text, tokens }.

const result = await optimizeReflective({
  id: "support-router-v1",            // one ID = one resumable experiment
  storage: "./mutara.db",
  implementation: { model: "my-model", scorer: "labels-v1" }, // what the result depends on
  initialPrompt: "Classify the support message.",
  objective: "Route refund requests correctly without breaking other intents.",
  cases: [
    { id: "t1", split: "train", input: { text: "I want my money back" }, expected: "refund" },
    { id: "v1", split: "validation", input: { text: "Where is my order?" }, expected: "shipping" },
    // ...a few dozen of each
  ],
  finalCases: [/* fresh cases, used only for the final check */],
  finalTest: { scoreRange: 1 },

  // 1. Run your task with a prompt. The model never sees the expected answer.
  run: async (prompt, c) => {
    const reply = await llm({ system: prompt, user: c.input.text });
    return { output: reply.text, cost: reply.tokens };
  },
  // 2. Score an answer. Feedback tells the next rewrite what went wrong.
  score: (receipt, c) => ({
    score: Number(receipt.output === c.expected),
    violation: 0,
    feedback: receipt.output === c.expected ? undefined : `expected ${c.expected}`,
  }),
  // 3. Ask a (usually stronger) model to rewrite the prompt from the failures.
  reflect: async ({ objective, parentPrompt, failures, parentScores }) => {
    const reply = await llm({ user: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) });
    return { text: reply.text, cost: reply.tokens };
  },

  rounds: 8,
  costLimit: 4000, reflectionCostLimit: 16000, budget: { cost: 2_000_000 },
});

console.log(result.champion);   // the best proven prompt
console.log(result.finalAudit); // original vs. best on fresh cases, with the test verdict
```

Run it again with the same `id` after a crash and it continues from the last
saved step. Change the task or the data and use a new `id`.

Try it locally without API keys:

```bash
pnpm install --frozen-lockfile
pnpm demo              # tune a classifier threshold; one "improvement" is caught as overfitting
pnpm demo:reflective   # the prompt loop above with a scripted model (wiring only, no real gain)
```

Prompts can also be split into named parts (`{ system, format, examples }`):
Mutara rewrites one part at a time and can combine the best parts of two
branches. Full options: [reflective.md](skills/mutara/references/reflective.md).

## Measured results

Every number below is measured on held-out cases that were never used to pick
the winner. Each example's README has the method, the raw numbers and the
negative results.

**Prompts** — [reflective-bench](examples/reflective-bench/): extract amount,
currency, date and vendor from payment messages. The expected format follows
rules the initial prompt never states (refunds are negative, ISO dates, vendor
without "GmbH"); the model can only learn them from failures.

| Run | Original → best, 60 unseen cases | Significant | Rounds | Tokens |
|---|---|---|---|---|
| 1 | 68% → 99% | yes | 2 | 121k |
| 2 | 68% → 100% | yes | 1 | 86k |

Two runs of one model on the easy task. Harder variants (fees, "1.2k",
chargebacks, payment intermediaries) and runs without scorer feedback are in
progress.

**Strategies** — same engine, no changes to the library:

| Example | What is tuned | Result on held-out |
|---|---|---|
| [Lunar Lander in wind](examples/lunar/) | 10 controller constants of Gymnasium's lander | solved episodes 51–64% → 78–95% (3 seeds, 200 episodes each) |

**What didn't work, on purpose shown:**

- Kuhn poker: greedy search plateaus with hidden information; plugging CFR in
  as the candidate source reaches equilibrium. This and other lessons from the
  removed game starters are in [LESSONS.md](examples/LESSONS.md).
- [Lunar gate vs. no gate](examples/lunar/#gate-vs-ungated-negative-result): on a
  10-constant controller the gate gave no measurable quality gain, only fewer
  promotions for the same quality.

## Not just prompts

| You have | Use |
|---|---|
| A prompt and examples to score it on | `optimizeReflective` from `teob-mutara/reflective` |
| Numeric settings or a fixed list of variants | `optimize` from `teob-mutara/optimizer` |
| Your own way to generate candidates (GEPA, Optuna, a hand-picked list, a solver) | `Adapter` from `teob-mutara` + `learnerHarness` from `teob-mutara/sqlite` |

Numeric settings in a few lines:

```js
import { optimize } from "teob-mutara/optimizer";

const execute = async (config) => ({ output: { error: (Number(config.x) - 1) ** 2 }, cost: 0 });
const result = await optimize({
  id: "quadratic-v1",
  space: { x: { type: "float", min: -10, max: 10, initial: 5 } },
  metrics: [{ name: "error", direction: "lower", weight: 1 }],
  implementation: { execute: execute.toString() },
  execute,
  recovery: "repeatable",
  decision: { mode: "heuristic" },
  budget: { trials: 25 },
  storage: "./optimizer.db",
});
console.log(result.champion);
```

Bring your own candidates: copy the [ready-made adapter](skills/mutara/assets/adapter.mjs)
and replace its task, data, candidates and acceptance rule. Mutara runs them,
applies the rule, tracks cost and saves every decision. See
[prompt-gate](examples/prompt-gate/) (fixed prompt candidates, validation gate,
final audit) and [shadow](examples/shadow/) (a new prompt against production
logs, without touching live traffic).

References: [API](skills/mutara/references/api.md) ·
[optimizer](skills/mutara/references/optimizer.md) ·
[evaluation method](skills/mutara/references/evaluation.md) ·
[recovery and rollback](skills/mutara/references/operations.md).

## How it compares

| | DSPy / GEPA | Optuna | W&B / MLflow | Mutara |
|---|---|---|---|---|
| Improves prompts by itself | Yes | No | No | Yes |
| Tunes numbers and strategies | Partly | Yes | No | Yes |
| Won't keep a change that only fits the training data | Validation score | Best trial | Manual review | Must win on unseen data, hard rules can't be traded away |
| Proves the final gain | No | No | No | Significance test on fresh cases |
| Survives a crash mid-run | Restart; LM cache skips some repeat calls | Finished trials kept, interrupted one re-runs | Logs only | Resumes at the exact step, no repeated paid calls |
| Stops before overspending | No | No | Logs, doesn't limit | Budget reserved before each call |
| Accepts any candidate source | No | No | — | Yes |
| Language | Python | Python | Python | TypeScript |

Mutara is not the strongest search algorithm. Its search is simple on purpose;
what it adds is the discipline around it — so you know the improvement is real
and you never lose work or money getting it. Plug a stronger search in through
the `Adapter` and keep the rest.

## Where it fits

| Use case | What to change | What to score |
|---|---|---|
| Prompts and extraction | Instructions, examples, output format | Accuracy, format compliance, tokens |
| RAG | Chunk size, overlap, top-k, reranking | Recall, answer correctness, citations |
| Tool use and model routing | Sequences, thresholds, fallbacks | Completion, cost, latency |
| Coding agents | Repair prompts, context selection, test policy | Tests passed, regressions, time |
| Games and simulations | Policy weights, components, exploration | Reward, win rate, transfer |

## Skill for agents

[skills/mutara/SKILL.md](skills/mutara/SKILL.md) teaches a coding agent to wire
Mutara into your project: find the integration point, pick the API, set up the
scorer and verify the improvement. It ships in the npm package
(`node_modules/teob-mutara/skills/mutara`).

For Codex:

```bash
mkdir -p ~/.codex/skills
ln -s /absolute/path/to/mutara/skills/mutara ~/.codex/skills/mutara
```

For other agents, copy the whole `skills/mutara` directory into their skills
folder. Example prompt:

> Use $mutara. Improve the support-routing prompt in this project. Compare the
> current and new prompt on separate test cases, show quality and cost.

## Project layout

- `src/` — the library; public imports `teob-mutara`, `teob-mutara/sqlite`,
  `teob-mutara/optimizer`, `teob-mutara/reflective`.
- `examples/` — measured examples above, plus [LESSONS.md](examples/LESSONS.md)
  — what the removed game starters taught about the engine.
- `skills/mutara/` — agent skill and adapter template.
- `test/` — library tests; `scripts/check-package.mjs` — clean-install check.

```bash
pnpm typecheck
pnpm test
pnpm demo
pnpm test:package
```

## Limitations

- The search itself is basic. For hard search spaces, plug in a stronger
  generator through the `Adapter`.
- Selection reuses the validation set every round, so train/validation numbers
  are optimistic. Report gains only from the final check on fresh cases.
- Mutara checks reported costs against the budget, but your runner must limit
  its own spending. For paid calls, the default recovery asks you to reconcile a
  lost response instead of silently paying again.
- Experiments are stored in SQLite. Never put API keys into `implementation` or
  case data.
- To resume an experiment, keep the same package version, lockfile and task
  code. Old experiment files are not migrated automatically.
