# The agent-journal hypothesis: verification and roadmap

## Hypothesis under test

> TEOB's event journal can serve simultaneously as (a) the agent's working
> memory, (b) its audit trail, and (c) its evaluation dataset — so that
> production traffic becomes an eval corpus for free, and past runs can be
> replayed against new agent logic to measure whether a change is an improvement.
>
> Temporal cannot do this, because its recovery model requires deterministic
> replay of workflow code, which forbids replaying old histories against new code.

The Temporal half of that claim holds (see [REPORT.md](REPORT.md) and the
determinism/versioning constraint their `patched`/`getVersion` APIs exist to
manage). **This document tests the TEOB half, which is where the claim was
overstated.**

---

## Verdict

*Original verdict, 2026-09-18:* **not implemented — the architecture permits
it, nothing in the codebase did it.** Two of the three modules named in the
claim had no connection to the journal, and the one that did had a correctness
defect that would have made historical replay wrong even once an adapter was
written.

*Revised after Stages 1–4, 2026-09-19:*

| Claim | Status |
|---|---|
| Journal is the agent's memory | **Still false** — `ai/memory` has its own store, untouched (Stage 7, lowest priority) |
| Journal is the audit trail | **True for `ai/node-flow`** — definition pinned (Stage 1), run boundaries real (Stage 3), model requests recorded (Stage 4) |
| Journal is the eval dataset | **True** — `datasetFromJournal` yields provenance-carrying samples that the existing `evaluateDataset` runs unchanged (Stage 5) |
| Past runs replayable against new logic | **True for a single node** — section Q replays under edited logic, deterministically, with zero effects; whole-flow replay is not built |

The two claims that were *unsound* rather than missing (F4, F12) are fixed. What
is left is genuinely missing capability: an evaluator shape (Q4/Stage 5),
whole-flow replay (Stage 6), memory-as-projection (Stage 7), and the
mailbox-serialisation defect (F13).

---

## Findings

### F1 — The eval module has zero journal linkage

`EvalDataset` is a hand-authored static array
([src/ai/eval/types.ts:33](../src/ai/eval/types.ts#L33)):

```ts
export interface EvalDataset {
  name: string;
  version: string;
  samples: EvalSample[];   // { id, prompt, expectedOutput?, context? }
}
```

`grep -rniE "journal|event|replay|persistence" src/ai/eval/` returns nothing.
`evaluateDataset` takes a `responseFn` and scores its output
([eval-runner.ts:30](../src/ai/eval/eval-runner.ts#L30)). This is a conventional
standalone LLM scorer, comparable to promptfoo or DeepEval. It is not connected
to anything event-sourced.

### F2 — Agent memory is a separate store

`src/ai/memory/` contains `memory-service.ts`,
`knowledge-backed-memory-service.ts`, `memory-tool.ts`. No reference to
journal, persistence, aggregate or replay. It is its own subsystem that happens
to live in the same repository.

### F3 — Only node-flow is actually event-sourced

`src/ai/node-flow/` has `aggregate.ts` and `projection.ts` and is the only part
of `src/ai/` that imports from `core/` (alongside `webhook-trigger.ts`). Agent
flows therefore *do* produce a journal. This is the real foundation the
hypothesis can be built on.

### F4 — Flow definitions are resolved from a mutable registry (correctness defect)

This is the most serious finding, and it is not only an eval problem.

The `flow_started` event records **only the definition's id**, not the
definition ([aggregate.ts:42](../src/ai/node-flow/aggregate.ts#L42)):

```ts
| { tag: "flow_started"; flowDefId: string; context: Record<string, unknown> }
```

On recovery, the definition is fetched from a live registry
([aggregate.ts:82–90](../src/ai/node-flow/aggregate.ts#L82)):

```ts
function getCompiled(state: NodeFlowState): CompiledFlow | undefined {
  if (state._compiled) return state._compiled;
  if (!state.flowDefId) return undefined;
  const def = registry.get(state.flowDefId);   // <-- mutable, current version
  ...
}
```

**Consequence:** edit a flow, and every in-flight *and* historical run replays
against the new definition. A run that executed nodes A→B→C under the old graph
will be reinterpreted under the new graph. The journal says what happened; the
code that interprets it has silently changed underneath.

This breaks the core event-sourcing guarantee that state is a pure function of
history. It undermines the audit claim (the reconstruction is not faithful),
the eval claim (you cannot recover the conditions of the original run), and it
is a live recovery hazard independent of both.

> **Correction (verified by probe, 2026-09-18).** The consequence above is
> half wrong. `apply` is pure and never reads the registry, so a *finished*
> run's reconstructed state does **not** change when the definition changes —
> the acceptance test originally proposed for Phase 1 ("mutate the registry,
> replay, compare state") passes today and proves nothing. The defect lives in
> `decide`: `nodesReadyToRun` and `terminalNodes` come from the current
> definition, so an **interrupted run continues under the new graph**. Probe: a
> run started under a→b→c, crashed in `b`, resumed with a→x→c registered —
> it executed `x`, which did not exist when it started. What is also lost is
> the ability to *know* which graph a historical run used, which is what eval
> and audit need. Acceptance: `R3` in the agent bench and the `F4` test in
> `test/ai/node-flow/journal-fidelity.test.ts`.
>
> **Still open**, but partly improved by the F9 fix: `_compiled` no longer exists,
> so `getCompiled` always consults the registry instead of sometimes returning a
> stale copy restored from a snapshot. The mutable-registry problem itself
> remains — pinning the definition is Phase 1.

### F5 — Node inputs are not recorded — **FIXED (Stage 4)**

Events carry `node_started { nodeId }` and `node_succeeded { nodeId, output }`
([aggregate.ts:42–58](../src/ai/node-flow/aggregate.ts#L42)). The actual input is
computed at execution time and discarded
([aggregate.ts:121](../src/ai/node-flow/aggregate.ts#L121)):

```ts
const signal = await exec(def, buildCtx(state));
```

Inputs are *derivable* — initial context is in `flow_started`, each output is in
`node_succeeded`, and the graph maps context to nodes. But derivation depends on
the flow definition, which F4 shows is not pinned. So today inputs are neither
recorded nor reliably reconstructible.

### F6 — The rendered prompt is never captured — **FIXED (Stage 4)**

Node definitions carry a `promptTemplate`
([nodes.ts:72, 92, 109, 139](../src/ai/node-flow/nodes.ts#L72)). The string
actually sent to the model — template plus interpolated context — is produced
inside `exec` and never persisted. For eval and for governance ("what exactly
did we ask the model?") the rendered prompt is the artifact that matters.

### F7 — node-flow already persists intent (good news)

Unlike `ctx.sync`, which fires without any durable record
([entity-runner.ts:224](../src/inmem/entity-runner.ts#L224)), `fireNode` emits
`node_started` **before** the side effect
([aggregate.ts:119–139](../src/ai/node-flow/aggregate.ts#L119)).

So the journal already contains the durable-intent record that
[RECOVERY-FEASIBILITY.md](RECOVERY-FEASIBILITY.md) identifies as the medium-cost
piece of work. For node-flow specifically, recovery needs only a sweeper that
finds `node_started` with no matching `node_succeeded`/`node_failed` and re-fires.
**node-flow is closer to durable execution than the rest of the framework.**

> **Correction (verified by probe).** "Only the sweeper is needed" is wrong.
> `recoverEntitiesOnStart` wakes the entity, but node-flow implements no
> `onRecoveryComplete`, so nothing re-fires the node whose `node_started` has
> no outcome — the run stays `running` forever (agent bench `R1`/`R2`). It
> also needs the definition, which after a restart is gone (F11). And the
> moment re-firing exists, Q2 stops being a Phase 4 concern: re-firing a node
> whose effect already happened (credit issued, ack lost) double-charges
> (`R4`). The intent record is necessary but not sufficient.

### F8 — The definition serializer already exists

`encodeFlowDef(def): NodeFlowDefJson`
([codec.ts:27](../src/ai/node-flow/codec.ts#L27)) already serialises a whole flow
definition to JSON, for Scala wire compatibility. Fixing F4 by embedding the
definition (or a content hash of it) into `flow_started` is therefore cheap — the
hard part is already written.

### F9 — node-flow snapshots destroy state — **FIXED**

Found while checking Q1. **This was a live defect, not a gap in the hypothesis.**

> **Status: fixed.** `nodeFlowStateCodec`
> ([src/ai/node-flow/codec.ts](../src/ai/node-flow/codec.ts)) now encodes the Maps
> and Set as arrays and omits `_compiled`, which was removed from `NodeFlowState`
> altogether — compiled flows are cached per definition id inside the aggregate
> closure instead. Regression test:
> [test/ai/node-flow/state-codec.test.ts](../test/ai/node-flow/state-codec.test.ts).
> The same defect was found and fixed in petrinet (see F10). The description
> below is kept as the record of what was wrong.

`NodeFlowState` holds `nodeStatuses: Map`, `nodeOutputs: Map`, `waitingNodes: Set`
([aggregate.ts:21–31](../src/ai/node-flow/aggregate.ts#L21)). node-flow ships
**no state codec** — callers supply one, and the repo's own test supplies a
pass-through ([webhook-trigger.test.ts:56](../test/webhook-trigger.test.ts#L56)).
Pass-through codecs hand the object to the journal as-is, and SQLite/Postgres
store it as JSON. `JSON.stringify(new Map([['a',1]]))` is `{}`.

Reproduction: [src/probe-snapshot.ts](src/probe-snapshot.ts), run with
`npx tsx src/probe-snapshot.ts`. Snapshot as actually stored:

```json
{"status":"completed","nodeStatuses":{},"nodeOutputs":{},
 "context":{"seed":42,"answer":"hello"},"waitingNodes":{},
 "flowDefId":"probe-flow","_compiled":{"def":{"id":"probe-flow","nodes":{}, ...
```

After restart:

```
nodeStatuses: {} size = undefined      // plain object, not a Map
RESULT: STATE LOST across snapshot round trip
```

Three consequences:

1. **All per-node state is erased** at the first snapshot. Any later `.get()` /
   `.set()` on `nodeStatuses` hits a plain object and throws.
2. **`_compiled` is persisted** — answering Q1: yes, it leaks. Worse, `getCompiled`
   returns it first (`if (state._compiled) return state._compiled`), so recovery
   uses the *corrupted* compiled flow (`def.nodes` is also `{}`) and never falls
   back to the registry.
3. **Silent until recovery.** The write succeeds; corruption only appears on
   restart.

Reachability: `snapshotEvery` defaults to 100 and node-flow does not override it.
An agent run with 30 tool calls emits ~60 events, so two runs on one entity cross
the threshold. Affects every JSON-backed journal, i.e. every production
deployment.

Fix direction: ship a proper `NodeFlowState` codec that encodes Maps/Sets as
arrays and drops `_compiled`, rather than leaving codec choice to callers. The
`_compiled` field arguably should not live in the state type at all.

### F10 — the same defect exists framework-wide — **FIXED**

F9 is an instance, not the disease. Verified in the core:

- `const snapshotEvery = aggregate.snapshotEvery ?? 100`
  ([entity-runner.ts:103](../src/inmem/entity-runner.ts#L103)) — auto-snapshot is
  on by default for **every** aggregate, not opt-in.
- `persistSnapshot` does `JSON.stringify(codec.encode(state))` with no
  validation ([sqlite/journal.ts:377](../src/sqlite/journal.ts#L377)).
- `SnapshotDecodeError` is only raised when `codec.decode` *throws*
  ([sqlite/journal.ts:397](../src/sqlite/journal.ts#L397)). `objectCodec.decode`
  is `return data as A` ([core/codec.ts](../src/core/codec.ts)) — it never throws.

So the failure is worse than "discovered at recovery": **nothing detects it at
recovery either.** The snapshot writes cleanly, decodes cleanly into garbage, and
the damage only appears when business logic later reads an empty collection.

Confirmed a second instance: petrinet's `FlowState` nests Maps and Sets three
levels deep (`flow.places` → `PlaceInstance.accepts`, `flow.transitions` →
`consumes`/`produces`, plus `tokenHistory`), ships no state codec, and its own
test registers it with a pass-through `objectCodec("FlowState")`.

> **Status: fixed, two layers.**
> 1. `flowStateCodec` ([src/petrinet/codec.ts](../src/petrinet/codec.ts)) for the
>    second instance, with
>    [test/petrinet-state-codec.test.ts](../test/petrinet-state-codec.test.ts).
> 2. A guard for the class: `findUnserializable()` in
>    [core/codec.ts](../src/core/codec.ts) walks a codec's encoded output for
>    Maps, Sets and functions; the entity runner runs it once per entity before
>    its first snapshot and logs a warning naming the offending path. It warns
>    rather than throws, so it cannot break a running system — it only turns a
>    silent bug into a visible one. Test:
>    [test/snapshot-shape-guard.test.ts](../test/snapshot-shape-guard.test.ts).

Remaining exposure: the guard fires only when a snapshot is actually written, so
an aggregate that never reaches `snapshotEvery` in testing still ships unchecked.
A stricter option — typing `Codec.encode` as returning a JSON-safe type — would
catch it at compile time, but changes a public interface every codec implements.
Not done; see Q7.

### F11 — the flow registry is process memory

The registry is a `Map` in the aggregate's closure, filled only by
`start_flow`. After a restart it is empty unless the application re-registers
every flow at boot, and `getCompiled()` then returns nothing: any command to an
interrupted run gets `{"tag":"error","message":"no flow running"}` and the run
is stranded. So pinning the definition (F4/Phase 1) is not an eval nicety — it
is a **precondition for recovery at all**. Acceptance: `R1`, and the `F11`
vitest.

### F12 — a second run on the same entity silently skips nodes

`start_flow` is accepted on a completed entity, but applying `flow_started`
copies the previous run's `nodeStatuses`. Every node that completed in run 1 is
considered done in run 2: on the support-agent flow the second ticket executed
only the two roots, and because the terminal node was still marked
`completed`, the flow reported **`flow_completed` without drafting, crediting
or notifying**. No error anywhere. It also means one entity's stream can hold
several runs with no boundary, which the journal→dataset adapter cannot
separate. Fix: reset per-node state in `flow_started` and give each run an id
(or forbid reuse). Acceptance: `R5`, the `F12` vitest.

> **Status: fixed 2026-09-19 (Stage 3).** The root cause was narrower than
> "state carries over": `decide` already projected the correct post-start state
> (`nodeStatuses` = every node `pending`,
> [aggregate.ts:252](../src/ai/node-flow/aggregate.ts#L252)) while `apply` kept
> the previous run's map. The two disagreed about what `flow_started` means, so
> run 2 fired its roots correctly and then had their completions judged against
> stale statuses. `apply` now rebuilds all-pending from the pinned
> `event.flowDef`, matching `decide`; legacy events without a pinned definition
> reset to an empty map, which `nodesReadyToRun` already treats as all-pending.
>
> **No run id was added.** `flow_started` *is* the boundary in the stream, so a
> sample's provenance is `(entityId, index of its flow_started)` — derivable,
> and 0 bytes on the 12 events/run. Add a real id only if runs ever need to be
> referenced across entities. `runs()` in the bench does the splitting.
> Acceptance: `R5` and the new `Q4` green, `F12` vitest flipped to `it`.

### F13 — node side effects run inside the entity's mailbox

`Run` effects are awaited inline in `executeEffect`, and `fireNode` returns the
node's whole execution as such an effect. Consequences, measured on the agent
bench (model 50 ms, tools 50 ms):

- parallel branches run one after another: p50 **218 ms** against a critical
  path of 150 ms and a fully sequential 200 ms;
- `start_flow` is acknowledged only after the root nodes finish;
- `get_state`, user messages and everything else addressed to the run block
  for the duration of every model call.

Not a blocker for the fidelity roadmap, but every latency figure for agent
flows measures this serialisation. Do not publish agent latency until it is
addressed (dispatch node execution outside the mailbox, feed results back via
`tellSelf` as today).

### F14 — Stage 1 already unblocked replay; inputs did not need recording

Found while adding section Q (2026-09-19). The roadmap assumed replay waits on
Stage 4 (capture inputs). It does not.

`apply` is pure and the definition is now pinned into `flow_started`, so the
context a node saw is a fold of the events before its `node_started` — and F5's
"derivable in principle, but the definition is not pinned" became derivable in
fact the moment Stage 1 landed. Section Q does exactly that and passes 3/3:
recorded runs reproduce their recorded answer byte-for-byte (Q1), the same
recorded inputs under an edited definition change every answer deterministically
with zero effects fired (Q2), and the effectful node's input rebuilds without
executing it (Q3).

**What this does not make true.** Derivation is not evidence: it re-runs the
current render code, so it answers "what would this input be" rather than "what
did we send". Audit and R6 still want the recorded artifact — Stage 4 stands,
with its justification narrowed from *replay* to *audit*. The flow also has no
hidden inputs; a node reading the clock, a random seed, or anything outside the
context will not reproduce, and nothing detects that today. And Q2 is effect-free
only because `draft` was chosen by hand — automating that choice is still
Stage 2. Finally, Q2 shows a *delta exists*, not that it is an improvement:
Q4 is untouched.

---

## Test harness for this roadmap

Every stage below is closed by a test that fails today.

- **`test/ai/node-flow/journal-fidelity.test.ts`** — minimal, in-memory,
  runs in `pnpm test`. Known defects are `it.fails`: the suite stays green, and
  when a fix lands vitest reports the test as unexpectedly passing, which is
  the signal to flip it to `it`. Each was verified to fail for the stated
  reason, not for a harness bug.
- **Section Q** in the agent bench — the hypothesis itself, not its
  preconditions. `contextAt` / `replayNode` in
  [bench/src/agent/run.ts](src/agent/run.ts) rebuild a node's input from the
  journal alone (a pure fold of `apply`, no runtime, no registry) and re-execute
  that one node. Q1 replays under the pinned definition and must reproduce the
  recorded answer; Q2 replays under an edited definition (`VARIANT`) and must
  differ on every run, deterministically, with zero effects; Q3 checks the
  effectful node's input is derivable without executing it.
  Negative control (run 2026-09-19, then deleted): dropping the
  `node_succeeded` merges from the fold takes Q1 from 5/5 to 0/5, so the
  assertion is load-bearing and not satisfied by any context.
- **`bench/src/agent/`** (`pnpm run bench:agent` / `npx tsx src/agent/run.ts`)
  — a support-agent flow on SQLite: two parallel roots (LLM classify, CRM
  lookup), an LLM draft, an effectful billing credit, an email. The mock model
  records every request (oracle for input capture); tools count effects that
  actually happened (oracle for "never repeat an effect"). Crashes are
  injected at named points, including *after* an effect but before its ack.
  Output: `results-agent.json`; exit code is non-zero only on an *unexpected*
  failure.

Baseline on 2026-09-18: A1–A3 pass; R1–R6 fail as known.
After Stage 1: A1–A3, R1–R3, R4a pass; R4, R5, R6 fail as known.
After section Q was added (2026-09-19): 10/13, the same three known failures.
After Stage 3 (2026-09-19): **12/14** — R4 (Stage 2) and R6 (Stage 4) are the
only known failures left.
After Stage 2 (2026-09-19): **14/15**, R6 the only known failure.
After Stage 5 (2026-09-19): **18/18**, section Q now runs the eval adapter and
the pairwise comparison end to end.
After Stage 4 (2026-09-19): **15/15, no known failures**. Full suite with
Postgres up: **1089 passed, 0 expected fail** — every `it.fails` marker in the
repo is gone. The bench is no longer a list of things that do not work; from
here a red case is a regression, not a roadmap item.
Journal: **12 events, ~1.4 KB per run**, of which `flow_completed` alone is
~31% because `finalContext` repeats the whole context (a cheap Q3 win).

---

## Roadmap

> Revised 2026-09-18 after probing. The original order put pinning the
> definition after recovery and treated effect classification as a replay
> concern; both were wrong (F4 correction, F7 correction, F11). Phase numbers
> below replace the earlier ones.

### Stage 0 — harness ✅

The agent bench and the fidelity test suite above. Done: without oracles for
model input and effect count, none of the later stages is checkable.

### Stage 1 — pinned definitions + resume (fixes F4, F11, the node-flow half of F7) ✅

These are one piece of work: a run cannot resume without its definition, and
pinning is pointless if nothing resumes.

- `flow_started` carries `flowDefHash`; definitions live in an immutable,
  content-addressed store (F8's `encodeFlowDef` gives the canonical bytes).
  The runtime registry becomes a cache over that store.
- `onRecoveryComplete` re-fires every node with `node_started` and no outcome.
- Until effect kinds exist (Stage 2), re-firing is only allowed for nodes that
  are safe to repeat; others go to `node_failed` with a clear reason rather
  than silently running twice.

**Acceptance:** R1, R2, R3 green; vitest `F7/F11`, `F11`, `F4` flipped to `it`.

> **Done 2026-09-18.** What landed:
>
> - `flow_started` now carries `flowDefHash` (`sha256:` over canonical JSON,
>   `src/ai/node-flow/pinning.ts`) and the encoded definition `flowDef`; both
>   are on `NodeFlowState` and in `nodeFlowStateCodec`. `getCompiled` resolves
>   by hash from state; the registry is only consulted for legacy runs whose
>   `flow_started` predates pinning (covered by a test).
> - `onRecoveryComplete` sends the new `resume` command when a running flow
>   has interrupted nodes. Repeatable nodes are re-driven with
>   `node_started { resumed: true }`; non-repeatable ones
>   (`defaultIsRepeatable`: tool calls, outbound messages, non-GET HTTP, LLM
>   calls with tools) get `node_failed` with an explicit reason, so the node's
>   `errorPolicy` decides. Override via `NodeFlowAggregateOpts.isRepeatable`.
> - `node_completed` / `node_failed` for a node that is not running are
>   ignored — completions are now at-least-once.
> - `start_flow` with a definition that cannot be compiled or encoded replies
>   `error` instead of throwing inside `decide`.
>
> Bench: R1, R2, R3 pass; new R4a ("recovery never repeats an effect")
> passes — R4 now ends in `flow_failed` with exactly one credit instead of
> hanging, and completes once Stage 2 lands. Vitest: 4 new tests (effect not
> repeated, duplicate completion ignored, hash stability, legacy journal);
> both safety tests were checked to fail when their guard is removed. The
> `state-codec` fixture was fixed: it passed an invalid definition through
> `as any` (a non-existent `transform` kind holding a function), which
> pinning rightly refuses to serialise.
>
> **Cost, and an open decision.** Embedding the definition takes
> `flow_started` from 144 B to ~1.8 KB and the whole run from ~1.4 KB to
> **~3.0 KB (2.1×)** on the agent bench. Embedding was chosen because it works
> on every journal backend without a schema change and keeps the journal
> self-sufficient, which is the hypothesis itself. The alternative — hash in
> the event, definition once in a content-addressed store — costs ~80 B per
> run but needs a `flow_definitions` table in SQLite and Postgres and a
> lookup on recovery. Decide once Stage 4 shows how large captured inputs
> make the journal anyway; if prompts dominate, 1.6 KB of definition does not
> matter.

### Stage 2 — effect kinds and at-most-once effects (Q2, pulled forward) ✅

`NodeDef` gets an effect classification (`pure` / `idempotent` with a key /
`effectful`). Effectful nodes get an idempotency key derived from
`(runId, nodeId)` passed to the tool, or a `node_effect_committed` event.
This is what both recovery (Stage 1) and replay (Stage 5) need.

**Acceptance:** R4 green — after a crash between effect and ack, the run
completes and `billing.credit` count is exactly 1.

> **Done 2026-09-19.** Framed around what is actually achievable: **the
> framework cannot make a non-idempotent tool safe.** Nothing can distinguish
> "the effect happened and the ack was lost" from "the effect never happened"
> without asking the outside world. So the framework does the two things it
> can — hand the tool a stable key so it can recognise the repeat, and refuse
> to retry when the tool has not said it can.
>
> - `MCPToolCall.idempotencyKey` is set for every tool node;
>   `ExecutorContext.idempotencyKey` carries it. Tools that cannot deduplicate
>   ignore the field, so this is additive for every existing tool.
> - The key is `` `${entityId}/${runSeq}/${nodeId}` ``. `runSeq` counts
>   `flow_started` events in the fold — **derived, not journaled**, same choice
>   as Stage 3. It is stable across recovery (both halves come from the same
>   events) and distinct between runs on one entity.
> - `mcp_tool_exec` gains `idempotent?: boolean`, meaning "this tool dedupes on
>   that key". `defaultIsRepeatable` returns it. Unset stays the conservative
>   Stage 1 behaviour: fail the node with a reason rather than act twice.
> - The bench's `billing.credit` now models a real payment API — the charge is
>   recorded under the key before the response is lost, so the retry returns the
>   original result. That is what makes R4 completable, and it is an assumption
>   about the *provider*, not about TEOB.
>
> **Only `mcp_tool_exec` got the flag.** `send_message` and non-GET `http_call`
> are equally effectful and stay non-repeatable; extending it is a one-line
> change per kind once something needs it.
>
> New hazard found while building it, now guarded: a key stable across recovery
> must still differ *between* runs. With `runSeq` dropped, the second ticket on
> an entity is deduplicated into the first one's charge and the customer is
> never paid — verified, `charged=1, wrongly deduped=1`. Acceptance: **R4, R4a
> and the new R7** green, plus a vitest checked to fail when the guard is
> removed.

### Stage 3 — run boundaries (fixes F12) ✅

`flow_started` resets per-node state and carries a `runId`; every node event
carries it too.

**Acceptance:** R5 green; vitest `F12` flipped.

> **Done 2026-09-19**, minus the `runId`, which turned out to be unnecessary —
> see the F12 status note. R5, Q4 and the `F12` vitest are green; the bench is
> 12/14 with R4 (Stage 2) and R6 (Stage 4) the only known failures left.

### Stage 4 — capture effective inputs (fixes F5, F6) ✅

Render prompts *before* persisting `node_started` (`renderTemplate` is pure)
and store the exact messages there; store resolved tool arguments likewise.
Re-measure journal size against the 1.4 KB/run baseline — this answers Q3.

**Acceptance:** R6 green — every request the mock model received is found
byte-identical in the journal, with no registry access; vitest `F5/F6`
flipped. Size delta recorded in `results-agent.json`.

> **Done 2026-09-19.** `resolveNodeInput(def, flowState)` in
> [executor.ts](../src/ai/node-flow/executor.ts) is a pure function producing
> the exact outward payload — rendered messages, resolved tool arguments,
> message body. `fireNode` calls it *before* persisting `node_started`, puts
> the result on the event, and hands the same object to the executor, which
> sends it instead of rendering again.
>
> **That last part is the point.** Journaling a second rendering would only
> give another derivation to compare; because there is now one resolution
> feeding both the event and the wire, the two *cannot* drift. R6 is therefore
> true by construction for every covered kind rather than merely observed —
> which is a stronger guarantee, and worth stating as such rather than as "the
> test passes".
>
> **Covered:** `llm_call`, `llm_extract`, `verify`, `plan` (all four model-call
> kinds), `mcp_tool_exec`, `send_message`. Found while building it: the agent
> bench only uses `llm_call`, so it could not see that the other three model
> kinds rendered their own prompts and journaled nothing — the claim "every
> model request is in the journal" would have been false for any flow using
> them. Guarded by a vitest covering all three, verified to fail when one kind
> is removed.
>
> **Not covered:** `http_call` and `knowledge_lookup` still build their request
> internally. Neither is a model call, so the F5/F6 claim holds, but a full
> audit trail of outbound requests would want them too.

### Stage 5 — eval shape, then journal → dataset (Q4 → old Phase 3) ✅

Decide Q4 on real journal data from Stage 4 before writing the adapter:
samples carry provenance (`runId`, `flowDefHash`, `eventId`), comparison is
pairwise (baseline vs candidate) with reference-free evaluators; similarity to
the recorded output is reported as *drift*, not quality. Two levels: node
(`messages → output`) and flow (`initial context → final context`) —
`evaluateDataset` today supports only the first.

**Acceptance:** `datasetFromJournal(category, range)` over the agent bench
journal yields samples that `evaluateDataset` runs unchanged.

> **Done 2026-09-19.** [`datasetFromJournal`](../src/ai/node-flow/dataset.ts)
> takes journal records in the `{ entityId, sequenceNr, event }` shape
> `Journal.allEvents` already returns, and emits one sample per model-calling
> node that completed. `evaluateDataset` consumes them with no changes to the
> eval module (bench `Q6`).
>
> - **Provenance** is `{ entityId, runSeq, nodeId, flowDefHash, sequenceNr,
>   messages, flowContext }`. No `runId` was invented — `flow_started` is the
>   boundary (Stage 3), so `runSeq` comes from the fold.
> - **Samples carry the context, not just the prompt.** A candidate that
>   changed a prompt *template* must re-render from `flowContext`; replaying
>   the frozen `messages` would apply the old template and measure nothing.
>   This is why `EvalSample.context` holds the JSON context rather than a
>   second copy of the prompt.
> - **`compareReports`** ([compare.ts](../src/ai/eval/compare.ts)) answers Q4's
>   shape: per-evaluator `candidate − baseline` over samples paired by id.
>   Evaluators present on one side only, or an unpaired sample set, are marked
>   `comparable: false` rather than silently averaged into a number that looks
>   like an answer.
>
> **Two defects the cases caught, both worth keeping.** `Q6` initially reported
> `+0.000` on both evaluators: the comparison ran and measured nothing, because
> the mock's output did not vary in anything they scored. `Q6` now requires a
> non-zero delta, so a vacuous comparison fails. `Q7` then failed for a real
> reason: `expectedOutput` is the node's serialized *output object* while the
> bench's `responseFn` returned the bare prose field, so no reference-based
> evaluator could ever match. A dataset's response space is the node's output
> space — `serializeOutput` is now exported so both sides agree.

### Stage 6 — replay harness (old Phase 4) — **mechanism done, see F14**

Re-run node logic against recorded inputs; effectful nodes are fed from the
record, never re-executed (Stage 2 makes that decidable).

**Acceptance:** change `draftStyle` in `bench/src/agent/flow.ts`, replay N
recorded runs: a deterministic per-evaluator delta, and effect counters at 0.

> **Partly done 2026-09-19.** Section Q (Q1–Q3) is that harness for a single
> node: `replayNode` re-executes it against a journal-derived input, effect
> counters stay at 0, and the delta is deterministic across two passes. Missing
> for full acceptance: whole-flow replay rather than one node, and the
> *per-evaluator* half — the delta today is "the answer changed", not a score.
> That is Stage 5's evaluator shape (Q4), which stays the real blocker. Feeding
> effectful nodes from the record still needs Stage 2 to know which they are;
> today the choice is hand-made.

### Stage 7 — memory as a projection (old Phase 5)

Unchanged: lowest priority.

### Parallel track — F13

Independent of the stages above; required before publishing agent latency.
**Acceptance:** agent bench latency p50 within ~10% of the critical path.

### Framework recovery outside node-flow

The rest of [RECOVERY-FEASIBILITY.md](RECOVERY-FEASIBILITY.md) (durable
timers, durable intent for `ctx.sync`, declarative retries) is unaffected and
still needed; test C2 in [src/teob/run.ts](src/teob/run.ts) remains its
acceptance.

---

## Open research questions

### Q1 — RESOLVED: yes, and it is worse than bloat

Answered by F9. `_compiled` is written into snapshots, comes back corrupted, and
is returned by `getCompiled` ahead of the registry. Folded into F9; fix there.

### Q2 — RESOLVED for recovery, still open for replay

Shipped as Stage 2: `mcp_tool_exec.idempotent` plus a per-`(entity, run, node)`
idempotency key. That is enough for recovery to decide what it may re-drive.

**Still open for replay.** The classification is binary — "this tool dedupes"
versus "do not retry" — and says nothing about whether a node is *pure*, which
is what Stage 6 needs to know which nodes can be re-executed against recorded
inputs and which must be fed from the record. Today section Q makes that choice
by hand (`draft`, an `llm_call` with no tools). A third state — pure, no
outside effect at all — is what would automate it.

### Q3 — Journal size once inputs are recorded

Measured today: **810 B/order** for 4 small domain events. Recording rendered
prompts and tool payloads could be 10–100× that. Consequences:

- The "4 events vs Temporal's 23" efficiency argument weakens further (it
  already drops from 5.8× to ~3.3× once durable intent lands).
- Retention cost becomes material rather than the 2.2% measured for Temporal.
- **But** if TEOB Cloud prices on retained volume
  ([POSITIONING.md](POSITIONING.md) §5.3), fat agent journals raise revenue.
  Worth modelling deliberately rather than discovering later.

Needs measurement on a realistic agent flow, not assumption.
**Baseline measured:** 12 events / ~1.4 KB per run on the agent bench, before
any input capture (Stage 4 will give the after figure).

> **Measured after Stage 4 (2026-09-19).** Still 12 events, now **3930 B/run** —
> 2.8× the pre-pinning baseline. Where it goes:
>
> | | B/run | share |
> |---|---|---|
> | `flow_started` (pinned definition) | 1792 | 46% |
> | `node_started` (captured inputs, 5 nodes) | 1065 | 27% |
> | `node_succeeded` | 639 | 16% |
> | `flow_completed` | 435 | 11% |
>
> **This does not settle the embed-vs-content-store decision, and the reason
> matters.** Stage 1 parked it on "if prompts dominate, 1.6 KB of definition
> does not matter". Prompts did *not* dominate — the definition is still the
> largest single item. But the bench's prompts are one-line templates over
> four short ticket strings, which is unrepresentative: a real agent prompt
> carrying retrieved context or conversation history is 10–100× this and would
> invert the table immediately. So the honest state is not "measurement says
> embed" — it is "this bench's prompts are too small to decide", which is a
> different reason to keep it parked than having no data at all. Deciding it
> needs a flow with realistic prompt sizes, not another run of this one.
>
> The efficiency argument moves accordingly: "4 events vs Temporal's 23" is
> about event *count*, which is unchanged, but bytes per run are now 2.8× the
> original figure. Retention cost (and the Q5 erasure surface) scales with the
> latter.

### Q4 — RESOLVED in shape, still open in substance

Production output is not a correct answer; it is just the previous answer. The
existing evaluators split into two kinds here:

- Reference-free (`jsonValid`, `regexMatch`, `lengthCheck`, `llmJudge` with a
  rubric) — usable directly on replayed output.
- Reference-based (`cosineSimilarity` against `expectedOutput`) — measures
  *similarity to the old behaviour*, which scores a genuine improvement as a
  regression.

The honest framing is A/B diffing plus a judge, not "matching expected output".
This needs design before Phase 3 fixes the wrong shape into the adapter.

> **Settled as a shape, 2026-09-19 (Stage 5), and demonstrated.** Comparison is
> pairwise between two candidates scored the same way; similarity to the
> recorded output is reported as drift, carrying no sign.
>
> Bench `Q7` makes the trap concrete rather than asserting it. The *same*
> candidate, over the same five recorded runs:
>
> | Evaluator | Baseline | Candidate | Reads as |
> |---|---|---|---|
> | `ExactMatch` vs recorded output | 1.0 | 0.0 | **−1.0: total regression** |
> | `Contains(["step"])`, reference-free | 0.0 | 1.0 | **+1.0: improvement** |
> | `LengthCheck(400)`, reference-free | 1.0 | 0.373 | −0.627 |
>
> A reference-based evaluator marks the improved candidate a complete
> regression purely for having changed. Two reference-free evaluators disagree
> with each other — better on one axis, worse on another. So "better" is not a
> scalar the framework can produce, and any single number claiming otherwise is
> hiding a choice of weights.
>
> **Still open in substance:** which evaluators a user should reach for. The
> bench uses `Contains`/`LengthCheck` because they are deterministic and make
> the disagreement visible, not because they judge support replies well. A real
> corpus wants a rubric judge, and `llmJudge` is generative, expensive and
> uncalibrated — the gap the TypeSafe `Score`/`Noul` primitives would fill.

### Q5 — PII and right-to-erasure versus an immutable log

If the journal is the eval corpus, it is also a personal-data surface, retained
by design forever. GDPR erasure against an append-only log is a known hard
problem (crypto-shredding, tombstones, per-subject keys). This collides directly
with the "keep it as long as you want, unlike Temporal's 90 days" pitch — the
same property that is an advantage for audit is a liability for erasure.

Must be answered before selling into EU fintech or healthcare, which is exactly
the wedge [POSITIONING.md](POSITIONING.md) proposes.

### Q6 — Does the hypothesis survive multi-version flows?

Once definitions are content-addressed (Phase 1), a corpus spans many flow
versions. Is an eval across heterogeneous definitions meaningful, or must the
corpus be filtered to one definition hash? Affects how useful "free production
corpus" really is for a fast-iterating team — which is the exact team the pitch
targets.

---

### Q7 — Should `Codec.encode` be typed JSON-safe?

`encode(value: A): unknown` lets any codec return a Map. Narrowing the return to
a recursive `JsonValue` would make the whole F9/F10 class a compile error instead
of a runtime warning, and cost nothing at runtime. It is a breaking change to a
public interface that every codec in the repo implements, so it needs a
deliberate decision rather than a drive-by fix.

## What may be claimed publicly today

**Defensible now:** agent flows in TEOB are event-sourced; the framework's
journal is a durable record of flow execution; the architecture decouples code
from history, so replaying old runs against new logic is structurally possible
where Temporal's deterministic-replay model forbids it.

**Newly defensible (F14, 2026-09-19, section Q):** a recorded agent run can be
replayed against edited flow logic using nothing but the journal — the input is
rebuilt, the edited logic answers differently and deterministically, and no side
effect fires. Demonstrated on the bench flow, with a negative control. State it
as *replay*, with the caveat that it holds for nodes whose input is fully in the
flow context.

**Newly defensible (Stage 4):** the journal is a *recorded* request archive, not
a derivation — every model request and resolved tool argument is persisted
before the effect runs, and the executor sends that exact object, so what was
journaled and what was sent cannot differ. This supersedes the caveat below.
For audit, say "the journal holds the request we sent"; that is now accurate for
all four model-call node kinds, tool calls and outbound messages. `http_call`
and `knowledge_lookup` are not yet covered.

**Newly defensible (Stage 5):** recorded production runs become an eval
dataset with no hand-authoring — provenance included, filterable by pinned
definition — and two candidates can be compared per evaluator over it.

**Still not defensible:** that agents "get better" *automatically*. The
framework now measures a difference and reports it per evaluator; choosing
which evaluators constitute "better" is the user's, and bench `Q7` shows why
it cannot be defaulted — a reference-based evaluator calls the improved
candidate a total regression, and two reference-free ones disagree with each
other. Say "measures the change, per evaluator you choose", never "makes
agents better". Nor any claim about
production traffic specifically — the corpus was a bench flow with no hidden
inputs, no PII (Q5) and one definition version (Q6). Nor whole-flow replay:
section Q replays one node, chosen by hand.

The gap is weeks, not quarters — but it is a gap. As of 2026-09-19 the
*incorrectness* half is closed: F4 and F11 fell with Stage 1, F12 with Stage 3,
so interrupted runs resume under the definition they started with and a reused
entity no longer reports success without doing the work. What remains is
missing capability rather than wrong behaviour: Stage 2 closed R4, so a run
interrupted after an effect now completes with the effect applied exactly once,
provided the tool deduplicates on the key it is given. Also not defensible: that node-flow
is "close to durable execution" (F7 correction), or any agent latency figure
(F13, still unaddressed and now measured at p50 209 ms against a 150 ms
critical path — worse than running the whole flow sequentially).
