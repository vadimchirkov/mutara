# Public API

Public entry points are `mutara` (core), `mutara/sqlite` (harness), and
`mutara/optimizer` (declarative search). Do not import internal `dist` files.
For parameter tuning, start with [optimizer.md](optimizer.md); this reference
covers custom adapters. All entry points include TypeScript declarations.
A strategy can be any validated `Identity`, or use the
built-in `Version<Config>` containing `id`, `parentId`, `implementationId`, `config`.

```ts
import {
  createLearner, version, validateVersion, digest, canonical,
  boundedDecision, type Adapter, type BasePlan, type Version,
} from "mutara";
import { learnerHarness } from "mutara/sqlite";
```

`version(config, implementationId, parentId = null)` clones finite JSON and hashes
its canonical representation. `validateVersion(v, implementationId)` rejects
changed content or implementation. Validate domain constraints separately.
`digest` sorts object keys, but preserves array order. Undefined, NaN, Infinity,
Date, Map and functions are not persistent values; convert them explicitly.

## Adapter<V, P, E>

`V extends Identity`; `P extends BasePlan<V>` (`initial: V`, `rounds: number`).
`E` is the host's JSON evaluation result. Rounds must be 1–100.

| Member | Contract |
|---|---|
| `implementation` | JSON artifacts sufficient to identify/reconstruct host behavior. Persisted in the starting event; included in the adapter hash. |
| `validatePlan(plan)` | Throw on invalid task configuration, data partitions or limits. |
| `validateVersion(version)` | Check both identity and domain constraints; throw on invalid configuration. |
| `limits(plan)` | `{ executions, cost }`: positive integer logical-job count, finite nonnegative cost budget. |
| `propose(champion, history, plan)` | Synchronous candidate; `parentId` must equal champion ID. Use recorded, reproducible inputs. |
| `jobs(champion, candidate, plan, round)` | Nonempty array of `{ key, input, costLimit }`. Zero-based round allows fresh paired cases. Unique nonempty string keys; finite nonnegative reservations. Mutara assigns IDs. |
| `recovery` | `repeatable`, `idempotent`, or `manual`; see operations reference. |
| `execute(job, plan)` | Promise of `{ output, cost }`. Enforce the reservation in the executor. |
| `grade(job, receipt, plan)` | Pure local `{ metrics: Record<string, number>, data }`, or `null` to await external feedback. Metrics must be finite. |
| `assess(runs, plan)` | `{ evaluation, decision: { accepted, reason } }`. Each run contains job, receipt and observation. |

Callbacks receive copies of persisted values. Closures and external application
state remain the host's responsibility. The engine executes jobs sequentially.
It reserves the entire candidate's job budget before beginning that candidate.
An accepted candidate becomes the experiment champion; rejected candidates remain
in history. It does not create new strategy primitives on its own.

## SQLite harness

```ts
const learner = learnerHarness("./learning.db", adapter);
try {
  await learner.start("globally-unique-experiment-id", plan);
  const result = await learner.wait("globally-unique-experiment-id");
  // Apply result.champion.config through the host's existing configuration path.
} finally {
  await learner.close();
}
```

Create the parent directory before using a nested database path. `:memory:` is
useful for a smoke test, but cannot recover across processes.

- `start(id, plan)` rejects starting the same persisted experiment twice.
- `startOrResume(id, plan)` starts from `idle`, otherwise returns the saved
  state. Same mismatch semantics as the manual pattern: a different plan or
  adapter fails at `wait`, not here.
- `state(id)` returns a copy and activates recovery for that entity if necessary.
- `wait(id, timeoutMs = 300000)` waits for `finished`; rejects on `failed`,
  `blocked` or timeout. Timeout does **not** cancel the executor or roll back effects.
- `send(id, command)` delivers `received`, `observed`, `rollback`, etc.
- `close()` shuts down the runtime. Finish or reconcile external work first.

State includes `champion`, `plan`, `trials`, `pending.runs`, `executions`, `spent`,
`coreId`, `adapterId`, `status` and optional `error`. No input deletes prior trials.

For an existing TEOB runtime, `createLearner(adapter, { category })` returns the
aggregate, category and event/state codecs for registration. The default category
is `learning`; use a distinct category per adapter within the same runtime.
`learnerHarness(path, adapter, { category })` accepts the same category option.

## Provenance limits

Mutara hashes its executing modules (TS during source development, JS in a built
package), the adapter's declared implementation and recovery mode. Use the same
package build, dependency lock and adapter artifact to resume a run. Hashes do not
capture undeclared closure values, external services or mutable datasets. An old
finished state can still be inspected; changing code is not a journal migration.
