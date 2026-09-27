# Reflective prompt optimization (GEPA-style)

`optimizeReflective` from `teob-mutara/reflective` adapts prompts over several
rounds. The initial prompt is evaluated once; each round then reflects on a
parent's train failures and evaluator feedback (GEPA's Actionable Side
Information) to propose one candidate, screens it on those failures, and gates
it against the champion on every train and validation case. The core engine is
untouched — reflection itself runs as a journaled `execute` job, so crash
recovery and cost budgets keep working.

```js
import { optimizeReflective } from "teob-mutara/reflective";

const result = await optimizeReflective({
  id: "support-prompts-v1",
  storage: "./reflective.db",
  implementation: {
    taskRunner: "support-agent-v3",
    evaluator: "intent-labels-v2",
    reflector: { model: "example-reflector-1", settings: "low-temperature" },
  },
  initialPrompt: "Classify the message.",
  objective: "Route refund requests correctly without touching other intents.",
  cases: [
    { id: "t1", split: "train", input: { text: "..." }, expected: "refund" },
    { id: "v1", split: "validation", input: { text: "..." }, expected: "other" },
  ],
  run: async (prompt, c, ctx) => {
    const res = await callAgent({ systemPrompt: prompt, text: c.input.text });
    return { output: res.label, cost: res.cost, trace: res.reasoning };
  },
  score: (receipt, c) => ({
    score: Number(receipt.output === c.expected),
    violation: 0,
    feedback: receipt.output === c.expected ? undefined : `expected ${c.expected}, got ${receipt.output}`,
  }),
  reflect: async ({ requestId, parentPrompt, failures, objective }) => {
    const text = await callReflector(buildMyReflectionPrompt({ parentPrompt, failures, objective }));
    return { text, cost: 0.02 };
  },
  rounds: 10,
  budget: { cost: 5 },
  finalCases: [{ id: "f1", input: { text: "..." }, expected: "refund" }],
});
console.log(result.champion, result.history.map((h) => h.accepted));
```

This is a wiring pattern with a scripted stub in
`examples/reflective-demo.mjs`; that demo proves plumbing, not a gain. For a
measurement with a real model see `examples/reflective-bench/`.

## Rounds and entities

One SQLite file holds single-round experiments:

- `<id>/seed` evaluates the initial prompt on every case once.
- `<id>/propose-r<N>` journals the reflection call that produced candidate N
  (merge rounds have none: a merge is a deterministic text combination).
- `<id>/screen-r<N>` runs the candidate only on the failures shown to the
  reflector (GEPA's minibatch check) and compares with the parent's recorded
  outcomes there. A candidate that does not strictly improve stops here.
- `<id>/select-r<N>` runs the candidate on the remaining cases, reuses the
  screened outcomes, and gates it against the champion's recorded outcomes.

Each prompt is evaluated once per case: the champion is not rerun every round.
With a stochastic task runner a lucky evaluation can therefore stick; judge the
final champion on `finalCases`, not on journal numbers.

Re-running with identical options replays finished entities without new model
calls. Changed options fail fast with a "recorded implementation or plan
changed" error; continue under a new experiment ID. Duplicate proposals skip
evaluation for that round. The loop stops early with `stopReason` once no
eligible parent has a train case scoring below `passScore`.

## Components and merge

`initialPrompt` may be a record of named components instead of one string:

```js
const result = await optimizeReflective({
  // ...same options as above
  initialPrompt: { system: "You route support tickets.", format: "Answer with one label." },
  run: async (prompts, c) => callAgent({ system: `${prompts.system}\n${prompts.format}`, text: c.input.text }),
  reflect: async ({ objective, component, parentPrompt, parentSystem, failures, parentScores }) => ({
    text: await callReflector(buildReflectionPrompt(objective, parentPrompt, failures, parentScores,
      { component, system: parentSystem })),
    cost: 0.02,
  }),
  maxMerges: 3,
});
result.champion; // { system: "...", format: "..." }
```

- Each reflection rewrites one component (`component`, `parentPrompt` is its
  text, `parentSystem` the whole record). Components rotate round-robin along
  each lineage in sorted key order; a child continues after its parent's
  component. A string prompt is the single component `"prompt"`.
- `maxMerges` (default 0) enables GEPA's system-aware merge. After a round adds
  a fully evaluated candidate, the next round first looks for two frontier
  prompts, neither descending from the other, whose most recent common
  ancestor each improved on a component the other left unchanged. The merge
  takes each side's own changes; components changed by both come from the
  higher-ranked frontier entry. It costs no model call, is screened on up to
  `maxFailures` train cases where the two parents disagree (it must match the
  better parent there), then faces the same champion gate. Without such a pair
  the round reflects as usual. With a single component no pair qualifies.
- History records carry `kind` (`"reflect"` or `"merge"`), `component` and, for
  merges, `mergeParent`; the result counts `merges`.

## Cases, truth and the gate

- Provide at least one `train` and one `validation` case with unique IDs.
- `run` receives only `{ id, split, input }`. Expected labels never reach the
  task runner; `score` sees the full case.
- The reflector sees up to `maxFailures` of the parent's lowest-scoring
  **train** cases below `passScore` (`input`, `expected`, `actual`, `trace`,
  `feedback` from `score`). Validation truth never enters reflection input;
  `finalCases` are report-only and never proposed from.
- Promotion is a strict heuristic, not a statistical guarantee: the candidate
  must beat the **champion's** mean score on both train and validation without
  increasing violations on either. Validation is reused every round, so
  anytime-valid tests from `decision.ts` would not hold here either; measure
  the final champion on held-out cases (see [evaluation.md](evaluation.md)) and
  do not present journal growth as improvement.

## Final test

With `finalCases`, set `finalTest: { scoreRange, minimumGain = 0, alpha = 0.05 }`
to add `finalAudit.test`: a paired anytime-valid betting test (`decision.ts`) of
champion vs. initial prompt. It is valid there, unlike during selection, because
final cases are fresh and there is one comparison. It accepts only if the gain is
significant and violations did not grow. `scoreRange` is max − min possible score.

## Parents, frontier and budgets

- `parentStrategy: "champion"` (default) mutates the current champion;
  `"pareto"` samples a seeded parent from GEPA's per-case frontier: prompts
  holding the best validation score on at least one case, not dominated case
  by case, weighted by the number of such cases. Children of any parent are
  still gated against the champion. Only parents with train failures are
  eligible.
- `budget.cost` covers seed evaluation, reflection and screening/selection.
  A round starts only if `reflectionCostLimit + cases * costLimit` fits; the
  loop stops with `stopReason` instead of overspending.
- `costLimit` reserves each task execution, `reflectionCostLimit` each
  reflection call. Receipts above their reservation fail the round.

## Recovery

- Default `recovery: "manual"`, matching paid model calls: a lost reflection
  or task response blocks the round for reconciliation instead of silently
  re-spending. `repeatable`/`idempotent` auto-retry every blocked job up to
  `maxRetries` (default 3) times each.
- Every reflection call receives a stable `requestId`
  (`<id>/reflect/<round>`); implement idempotent reflector calls keyed by it
  when the provider supports deduplication. See [operations.md](operations.md).
- `runEntity` helpers are internal; drive recovery by re-running
  `optimizeReflective` after reconciling, or send `received`/`retry` on the
  `<id>/seed`, `<id>/propose-r<N>`, `<id>/screen-r<N>` or `<id>/select-r<N>`
  entity directly.

## Options

| Option | Contract / default |
|---|---|
| `id` / `storage` | Nonempty experiment ID; SQLite path (durable for resumable work). |
| `implementation` | Required finite JSON pinning runner, evaluator and reflector versions. No credentials. |
| `initialPrompt` | Nonempty string, or 1–20 named nonempty components; each within `maxPromptChars`. |
| `objective` | Nonempty string, max 4000 chars. |
| `cases` / `finalCases` | 2–500 cases, unique IDs, both splits present; final IDs disjoint from selection. |
| `run` / `score` / `reflect` | Required callbacks; `reflect` returns `{ text, cost }`. |
| `rounds` | 1–100; default 10. |
| `maxFailures` | 1–20 train failures per reflection (also the screen minibatch); default 5. |
| `passScore` | Train cases scoring at or above it count as solved; default 1. Set it for non-[0, 1] scores. |
| `maxPromptChars` | 1–64000 per component; default 8000. |
| `maxMerges` | 0–100 merge attempts; default 0. |
| `finalTest` | Optional `{ scoreRange, minimumGain?, alpha? }`; needs `finalCases`. |
| `costLimit` / `reflectionCostLimit` | Nonnegative reservations; default 0. |
| `budget.cost` | Total cost budget; default 0. |
| `recovery` | Default `manual`. |
| `parentStrategy` / `seed` | `champion` (default) or `pareto`; seed default 7919. |
| `maxRetries` | 0–10 retries per failed job; default 3. Only for non-manual recovery. |
| `concurrency` | Task calls of one evaluation stage in flight at once; default 1. Same results as sequential; not pinned. Reflection calls stay one at a time. |

Pure helpers (`buildReflectionPrompt`, `paretoFrontier`, `selectParent`) are
exported for testing custom variations. `buildReflectionPrompt` takes an
optional `{ component, system }` context for multi-component systems.
