# Declarative optimizer

Revised 2026-09-21 after checking the initial design against the core's recovery,
cost and evaluation contracts. Implemented in `src/optimizer.ts`, `src/search.ts`
and `src/multi-metric.ts`.

## Architecture

`space + metrics + executor → Adapter + Plan → createLearner → TEOB`

`createOptimizer(options)` synthesizes an adapter and plan. Register that adapter
with `createLearner` in an existing TEOB runtime, or use `learnerHarness`.
`optimize({ ...options, id, storage })` runs or reopens that same experiment using
the SQLite harness. It does not implement a second scheduler.

One experiment has 1–100 trials, with a fixed plan and one budget. The initial
proposal to chain epochs was removed: it split recovery, identities and the
comparison budget across a second lifecycle without a demonstrated need.

## Contract

| Field | Meaning |
|---|---|
| `space` | Named float/int ranges or string enums, each with an initial value. |
| `metrics` | Names, directions and positive weights. Fixed min/max bounds required for bounded decisions. |
| `implementation` | Finite JSON identifying executor, evaluator, dataset, model and dependencies as applicable. No secrets. |
| `execute(config, context)` | Returns `{ output: Record<string, number>, cost: number }`. |
| `recovery` | Defaults to `manual`. `repeatable` is for safe simulations; `idempotent` requires executor deduplication. |
| `decision` | Defaults to `{ mode: "bounded" }`. Explicit `heuristic` is a mean-gain rule without confidence claims. Both accept `minimumGain` (default 0); bounded also accepts `alpha` (default 0.05). |
| `samplesPerTrial` | Paired cases per trial, default 1. Repetition alone does not establish statistical significance. |
| `budget` | `{ trials, cost? }`, default `{ trials: 50, cost: 0 }`. |
| `costLimit` | Per-execution reservation, default 0. Executor must enforce it. |
| `seed` | Deterministic candidate search seed, default 7919. |
| `id`, `storage` | Required experiment ID and optional SQLite path for `optimize`; storage defaults to `:memory:`. |

Execution context contains a stable job `id`, `sample` index and `costLimit`.
Baseline and candidate receive identical indices; each round uses a fresh block.
The host maps these indices to cases from its pinned dataset, keeps truth out of
model inputs, and supplies enough independent cases for the planned experiment.
Recycling a small dataset does not provide an independent statistical test.

The result contains `id`, `champion`, `history`, `totalTrials`, `executions` and
`spent`. History retains candidate metrics and acceptance reasons. Full paired
observations and receipts remain in the TEOB journal.

## Acceptance

Metric differences are oriented by direction and combined with explicit weights.
All required values must be finite and within declared bounds. Missing or invalid
observations fail before executing the next job.

For bounded decisions, the difference range is fixed before observations:

`range = 2 × sum(weight × (max - min))`

The existing `boundedDecision` uses that range and the full experiment's trial
budget. It does not estimate bounds from samples or bypass the confidence gate
when observations agree. One lucky observation cannot establish a bounded gain.
Adaptive candidates still require fresh independent evaluation cases, and a
separate final holdout is needed to report the selected champion's performance.

Heuristic mode accepts mean composite gain above `minimumGain` and labels the
reason accordingly. It is useful for deterministic examples; it does not promise
statistical significance. Weights express user-approved tradeoffs, not hard
quality constraints. For hard constraints or another evaluation protocol, use
the existing `Adapter.assess` interface rather than extending this wrapper.

## Recovery and budgets

All progress is owned by the core experiment. Reopening the same ID returns a
finished result without executing again, or activates the core recovery policy.
Changing options, artifacts or the recorded implementation requires a new ID.
Optimizer, search and decision module contents are included in its artifact.
Undeclared closure values, mutable data and external services cannot be detected.

The entire next trial must fit the remaining reservation budget before any of
its jobs execute. Reported costs enter receipts and the core ledger. Excessive
receipts block the experiment; an executor must prevent overspending itself.
Execution counts cover logical jobs, not transport retries.

An executor error or uncertain manual recovery blocks until reconciled. Use
`createOptimizer` to reconstruct the same adapter, open `learnerHarness`, inspect
`state(id)`, then send `received` with the current job ID and actual receipt as
described in the operations reference. Do not infer an outcome or reset history.

Only one runtime should own a given experiment at a time. `:memory:` cannot
recover across processes. Source TS and built JS have distinct artifact hashes.
Existing journals require their recorded code; this revision does not migrate them.

## Verification and scope

Tests cover cost reservations, paired cases, evidence thresholds, repeated opens,
manual reconciliation, idempotent crash recovery and changed-artifact rejection.
The package check exercises the public optimizer export in a clean consumer.

Random search remains the only built-in strategy. New search algorithms,
continuous campaigns, caching and concurrency need a measured use case. Alchemy
remains the existing benchmark; a synthetic math test establishes wiring only.
