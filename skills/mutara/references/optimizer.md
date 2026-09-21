# Declarative optimizer

Use `optimize` when settings fit numeric ranges or fixed string choices and the
executor returns metrics with each result. It builds a core `Adapter` and plan;
there is no separate scheduler. Search is seeded, uniform and independent across
dimensions. Candidates are compared with the current champion, which changes
only after acceptance. There is no automatic production configuration update.

```js
import { optimize } from "mutara/optimizer";

const execute = async (config) => ({
  output: { error: (Number(config.x) - 1) ** 2 },
  cost: 0,
});
const result = await optimize({
  id: "quadratic-v1",
  storage: "./optimizer.db",
  space: { x: { type: "float", min: -10, max: 10, initial: 5 } },
  metrics: [{ name: "error", direction: "lower", weight: 1 }],
  implementation: { execute: execute.toString() },
  execute,
  decision: { mode: "heuristic" },
  recovery: "repeatable",
  budget: { trials: 25 },
});
console.log(result.champion, result.totalTrials, result.spent);
```

This is a deterministic wiring example. Function text identifies this standalone
executor only. For a real task, record source or content hashes, immutable dataset
and evaluator versions, dependency lock, prompt variants, model and settings.
Keep credentials and mutable external state out of `implementation`. Undeclared
closures and services are not captured by hashing a function.

## Options and defaults

Import `OptimizerOptions`, `OptimizeOptions`, `OptimizerResult`, `ExecutionContext`,
`Space`, `Dimension`, `Metric` and `DecisionRule` types from `mutara/optimizer`.

| Option | Contract / default |
|---|---|
| `id` | Nonempty experiment ID, required by `optimize`; globally unique across shared executors. |
| `storage` | SQLite path; default `:memory:` cannot survive process exit. Create parent directories first. |
| `space` | Nonempty object of dimensions, each declaring `initial`. Shapes below. |
| `metrics` | Nonempty list of unique names, `higher`/`lower` direction and positive finite `weight`. |
| `implementation` | Required finite JSON pinning executor and evaluation artifacts. |
| `execute(config, context)` | Async function returning `{ output: Record<string, number>, cost: number }`. |
| `decision` | Default `{ mode: "bounded" }`. Both modes allow `minimumGain` (default 0); bounded allows `alpha` (default 0.05). |
| `samplesPerTrial` | Positive integer paired cases per trial; default 1. |
| `budget` | Default `{ trials: 50, cost: 0 }`; trials must be 1–100. Cost units belong to the host. |
| `costLimit` | Nonnegative per-execution reservation; default 0. |
| `seed` | Safe integer search seed; default 7919. Does not control remote model randomness. |
| `recovery` | Default `manual`; alternatives `repeatable` and `idempotent` require the corresponding executor guarantees. |

Dimension shapes:

```ts
{ type: "float", min: 0, max: 1, initial: 0.5 }
{ type: "int", min: 1, max: 10, initial: 3 }
{ type: "enum", values: ["concise", "detailed"], initial: "concise" }
```

Numeric bounds must be finite with `min < max`; integer values/bounds must be safe
integers. Initial values must lie within bounds or enum choices. Enum choices are
unique strings. Integer sampling includes both bounds. Config values are typed
as `unknown`; narrow them at the host integration point.

## Cases, metrics and decisions

`context` contains `{ id, sample, costLimit }`. For zero-based trial `r` and case
`i`, `sample = r * samplesPerTrial + i`. Baseline and candidate use that same
index, but distinct job IDs. Jobs execute sequentially, baseline then candidate
for each case. Map `sample` to a pinned task; use `id` for actual idempotency.

Prepare `trials * samplesPerTrial` independent evaluation cases for bounded
search. Do not recycle indices with modulo or treat repetitions of the same
task as independent evidence. Keep labels out of agent inputs. Reserve separate
final held-out cases to compare the original strategy and selected champion;
the optimizer does not make this split for you.

Each output must include every declared metric as a finite number within any
declared bounds. The composite paired gain is:

```text
sum(weight * (candidate - baseline) * direction)
direction = +1 for higher, -1 for lower
```

There is no normalization. Choose weights in the metrics' actual units.
`minimumGain` uses composite units. Metric weights express tradeoffs; use custom
`Adapter.assess` for hard limits such as “never reduce accuracy.” Receipt `cost`
only updates accounting; to optimize cost, also return it as an output metric.

- `heuristic`: accept when mean composite gain strictly exceeds `minimumGain`.
  Ties reject; this provides no confidence guarantee.
- `bounded`: each metric requires fixed `bounds: { min, max }`. Uses a one-sided
  Hoeffding gate with `range = 2 * sum(weight * (max - min))` and the full declared
  trial count as the comparison budget. A single sample cannot pass at default
  alpha, even with maximal gain. Choose sample counts before observing results.

See [evaluation.md](evaluation.md) for the assumptions and final evaluation.

## Budgets, results and reopening

With `T` trials and `S` paired cases, a complete run executes `2 * T * S` logical
jobs. Before each trial, the engine reserves `2 * S * costLimit` against remaining
cost budget. `2 * T * S * costLimit` covers the whole plan at maximum charge.
Actual receipt costs accumulate in `spent`; retries are not new logical jobs.
The executor must enforce its own spending limit.

Insufficient budget for the first trial rejects setup. Exhaustion at a later
trial marks the experiment `failed`, and `optimize` rejects instead of returning
a partial result. Inspect saved state with the harness. An executor error or
excessive receipt blocks work for reconciliation; invalid metric output fails
grading. These are different from rejecting a valid but inferior candidate.

The result contains:

- `champion`: plain winning configuration, not a version object.
- `history`: each candidate's `config`, mean `metrics`, `accepted` and `reason`.
  These are selection measurements, not final held-out scores.
- `id`, `totalTrials`, `executions`, `spent`: identity and accounting.

Full versions, paired observations and receipts remain in the journal. Reopening
the same database and ID with identical options/artifacts resumes work or returns
the finished result without executions. Use one runtime owner per experiment.
Changed settings, code or dependencies require a new ID; preserve old journals
and their executable artifacts. Built JS and source TS have distinct hashes.

`optimize` waits up to five minutes and closes its harness in `finally`. A timeout
does not cancel external work. For longer runs, explicit lifecycle control,
manual reconciliation or rollback, use the same options with `createOptimizer`:

```js
import { createOptimizer } from "mutara/optimizer";
import { learnerHarness } from "mutara/sqlite";

// options: original optimizer options, including id, storage and execute.
const { adapter, plan } = createOptimizer(options);
const learner = learnerHarness(options.storage, adapter);
try {
  const saved = await learner.state(options.id);
  if (saved.status === "idle") await learner.start(options.id, plan);
  const state = await learner.wait(options.id, 30 * 60_000);
  console.log(state.champion.config); // Harness exposes the full Version.
} finally {
  await learner.close();
}
```

For blocked work, inspect `state.error` and `state.pending.runs`, then reconcile
the actual receipt before calling `wait`; follow [operations.md](operations.md).
Keep the default harness category `learning` when reopening an experiment made
by `optimize`. For an existing TEOB runtime, register this adapter with
`createLearner(adapter, { category })` as described in [api.md](api.md).
