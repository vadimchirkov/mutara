# Execution, feedback and recovery

For `optimize`, pass a durable `storage` path and reopen with identical options
and ID. For inspection, manual reconciliation or rollback, reconstruct its
adapter with `createOptimizer(options)` and open `learnerHarness` on the same
database with the default category. See [optimizer.md](optimizer.md).
Keep one runtime owner per experiment; close the original before reopening.

Mutara records a request before invoking `execute`, then records its receipt and
grade separately. The process can fail after an external effect but before its
receipt is durable. Choose a recovery policy that matches that ambiguity:

| Mode | When it is appropriate | Recovery of a requested job without a receipt |
|---|---|---|
| `repeatable` | Safe local simulation with no paid or externally visible duplicate effect | Executes again. |
| `idempotent` | Executor/provider guarantees deduplication and stable billing for `job.id` | Executes with the same ID. |
| `manual` | Such a guarantee is absent, including ordinary paid model calls | Blocks; reconcile the original result. |

An API header named idempotency-key is not a guarantee unless the provider supports
its semantics. Use globally unique experiment IDs: job IDs are
`encodedCategory/encodedExperimentId/round/jobIndex`. Do not reuse them across independent databases sharing
an executor's deduplication store.

The published TEOB runtime recovers an entity when addressed. Reopen the harness
and call `state(id)` or `wait(id)` for known running experiments; opening a database
does not automatically discover and resume every experiment. Keep experiment IDs
in the host's durable task records.

## Blocked work

Executor errors and invalid/excessive receipts block the run. Invalid metrics
detected during grading mark it `failed` instead. Inspect
`state.error` and `state.pending.runs`; do not delete journal events or invent a
receipt to make progress. Reconcile the provider's actual result and accounting:

```ts
await learner.send(id, {
  tag: "received", jobId,
  receipt: { output: recordedProviderResult, cost: recordedCost },
});
```

The receipt must match the current requested job and its reservation. An unknown
outcome may need human/provider investigation. A run already marked `failed` is
not automatically restarted by sending `advance`; correct the cause and start a
new experiment with a new ID. Resuming requires the recorded implementation.
A mismatched implementation is rejected without changing the journal, so restoring
the original code still allows a running experiment to resume.

Execution limits count logical jobs, not transport attempts. Cost limits are
reservations checked before work and on receipt; they cannot undo overspending
by an executor. Enforce caps/timeouts in the API client. Over-reservation receipts
are rejected and their claimed cost is not added to `spent`; reconcile separately.

## Delayed feedback

Return `null` from `grade` when a receipt needs a human or asynchronous evaluator.
The state remains `running`; already saved receipts are not executed again. Later:

```ts
await learner.send(id, {
  tag: "observed", jobId,
  observation: { metrics: { accuracy: 0.9 }, data: { evaluationVersion: "review-3" } },
});
```

Only the current job can receive an observation. Duplicate or stale feedback is
ignored. Use `state` to inspect such runs; `wait` may time out while feedback is
pending and does not cancel the run.

## Applying and reverting a strategy

After evaluation, explicitly load the champion into the host's configuration path.
Prefer a small adapter around the existing task runner; do not replace the host's
orchestration unnecessarily. Record which experiment/version the host is using.

```ts
await learner.send(id, {
  tag: "rollback", versionId: previousAcceptedId, reason: "held-out regression",
});
const restored = await learner.state(id);
// Apply restored.champion.config through the same host configuration path.
```

Rollback is allowed only after an experiment finishes, to its initial or an
accepted version. It changes the journaled champion, not past API effects or
production state automatically. Preserve database backups and dependency locks;
there is no automatic migration between the old Alchemy schema and Mutara.
