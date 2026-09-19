# teob-alchemy

A bench for self-improving agents built on [TEOB-TS](https://github.com/lambda-house/teob-ts),
using Little Alchemy 2 as the world.

It exists to test one claim from `AGENT-JOURNAL-HYPOTHESIS.md`: that an
event-sourced journal can serve as an agent's memory, its audit trail and its
evaluation corpus at once — so that past runs make future runs better, and a
change to agent logic can be measured against recorded history.

Games are useful here because they supply what production does not: **ground
truth**. The recipe table says exactly which combinations work, so a run can be
scored without a judge — and a judge, once added, can be validated against that
score instead of being trusted.

## Result

Ten games, 158 attempts each, identical policy in both arms. The only difference
is whether the agent may read the journal of its earlier games.

```
baseline random       30.1
baseline recency      21.1
baseline empowerment  42.7
baseline oracle      166.7      <- ceiling, reads the recipe table
human median          51        <- Brändle et al. 2023, n = 29,493

blind   43 43 43 43 43 43 42 43 43 43   mean 42.9
memory  43 54 58 64 66 69 73 77 79 79   mean 66.2

lift 23.3 elements/game
journal 160 events, ~15 kB per game
```

The blind arm is flat, as it must be: every game starts from nothing. The
memory arm rises monotonically and passes the human median at game three.

Reproduce with `pnpm run bench`; the numbers land in `results-alchemy.json`.

## The Q4 control: do evaluators agree with the truth?

`AGENT-JOURNAL-HYPOTHESIS.md` settles Q4 in shape — "better" is not a scalar,
and a reference-based evaluator marks any change a regression — but leaves it
open in substance: *which* evaluators should a user reach for? The framework
cannot answer that, because a support reply has no correct answer to check
against. This bench can.

Every recorded state is replayed and each candidate answers the same question —
what would you pick here? — so nothing diverges into a different game. Alongside
the usual evaluators, a `GroundTruth` one consults the recipe table.

```
candidate      GroundTruth  PriorPlausible      ExactMatch        Contains     LengthCheck
recorded             0.258           0.654           1.000           0.175           1.000
random               0.175           0.521           0.025           0.075           0.997
oracle               1.000           0.625           0.058           0.133           0.996

correlation with the truth, pooled over 360 scored answers:
  PriorPlausible   r =  0.151
  ExactMatch       r = -0.256
  Contains         r =  0.067
  LengthCheck      r = -0.034
```

`oracle` plays perfectly — 1.000 against the recorded run's 0.258 — and **every
other evaluator scores it as a regression.** `ExactMatch` is the known trap, but
the reference-free ones fail too, and `ExactMatch` is worse than useless:
negatively correlated with being right.

The interesting one is `PriorPlausible`, which is what a reasonable rubric judge
looks like — reference-free, never reads the table, rewards pairs whose elements
have produced before. It still only reaches r = 0.151. So "reference-free" is not
the property that makes an evaluator safe, and an evaluator that does not encode
the task still emits a confident number.

Which is the point: on a corpus with ground truth you can *catch* that. Run
`pnpm run q4`. The same method applies to any judge added later, including a
TypeSafe `Score` — the question is not whether it produces numbers, but whether
its numbers move with being right.

## What this measures, and what it does not

The lift above is **recall, not generalisation**. By game ten the agent has
tried ~1,580 pairs and remembers which of them produced something; it is
replaying its own discoveries, not reasoning about elements it has never
combined. That is a real and useful form of self-improvement — it is what the
journal buys for free — but it is not world knowledge.

The gap between 79 and the oracle's 167 is where world knowledge could help.
The TypeSafe bench below tests this: model scores rerank untried pairs, and the
recipe table measures whether that choice helped. The original bench remains
offline; model calls are opt-in through `bench:semantic`.

The human median is quoted for orientation, not as a controlled comparison:
Brändle's participants played the real game in a UI, where 158 was their mean
number of attempts rather than a hard cap.

## Layout

```
src/game/table.ts      recipe table, content-hashed; name-shuffling ablation
src/game/policies.ts   pair-selection policies, pure, journal-derived
src/game/engine.ts     game state and the single pure step
src/aggregate.ts       the game as a TEOB aggregate: one entity per game
src/memory.ts          the Memory type and the one fold that builds it
src/provenance.ts      hashes of the policy code and the prior, for the journal
src/harness.ts         SQLite runtime wiring
src/offline.ts         baselines with no runtime at all
src/play.ts            the playable terminal game, and policy playback
src/sessions.ts        hand-played sessions: record, load, project
src/ui/sprites.ts      8x8 pixel sprites in half-block characters
src/run.ts             the two-arm bench
src/q4.ts              the Q4 control: dataset, truth evaluator, correlation
src/q4-control.ts      its runner
src/judge.ts           TypeSafe request, validation and shortlist ranking
src/semantic-bench.ts  live model bench, calibration and offline journal replay
test/determinism.test.ts
test/snapshot.test.ts
test/aggregate-properties.test.ts
test/q4.test.ts
```

## What was built on top of the engine

The game itself is a lookup table and one pure function. Everything below is the
part that makes it a bench for *event-sourced* agents rather than a puzzle
solver.

**The game is an aggregate, not a loop.** One entity per game, one
`pair_tried` event per attempt, state as a pure fold over those events. node-flow
was the obvious candidate and is the wrong tool here: it compiles to a DAG and
rejects cycles, so a 158-iteration loop cannot be one flow run. A plain aggregate
is what the framework is for, and it keeps the journal as the complete record.

**Model calls are journaled effects.** `decide` persists `judgment_requested`
before a `Run` effect sends that exact payload. The response, usage and selected
`pair_tried` are committed together. Duplicate completions cannot spend another
game attempt. Recovery reuses an unfinished request; because inference has no
provider idempotency contract, a crash after inference but before persistence
can incur another API charge. This is not exactly-once billing. Explicit
429/529 rejections get bounded backoff; other API errors fail the game visibly.

**The entity drives its own game.** `decide` ends each attempt with
`ctx.tellSelf({ tag: "attempt" })`, and `onRecoveryComplete` re-issues one if a
recovered game is still `playing`. The loop used to live in the harness, which
meant a game interrupted by a restart sat in `playing` forever — the F7/F11
failure, one level down. The workflow here is "repeat until the budget is spent",
which is small enough to belong in the aggregate rather than above it.

Recovery only works because the harness calls `runtime.start()`:
`recoverEntitiesOnStart` wakes dormant entities at start, and entities are
otherwise created lazily, so without that call the interrupted game is never
woken and `onRecoveryComplete` never runs.

**The journal pins its decision inputs.** `game_started` carries a `sha256` of
the recipe table, of the policy's code, and of the prior the run started from.
This is the F4 lesson: pinning only the table would leave the journal saying
`empowerment` while the code behind that name had changed underneath, and no
reader could tell which prior produced a run. The hashes are provenance markers,
not semantic versions — reformatting a policy changes its hash without changing
its behaviour. The policy marker hashes the function body, not transitive
dependencies or closure values. Recovery rejects a mismatched marker, world or
prior; it does not restore historical code. Model version and shortlist size
are recorded at game start, and each model request includes its full question.

**State is JSON-safe by construction.** Arrays and plain objects, no `Map` or
`Set` anywhere in `GameState`. That is the F9/F10 defect — a `Map` in aggregate
state is silently erased by `JSON.stringify` at the first snapshot, and nothing
detects it at recovery.

**Memory is a projection, not a store.** `foldAttempts` turns recorded attempts
into a prior: pairs proved dead are skipped, pairs proved productive are
preferred. It holds no state of its own and can be deleted and rebuilt from
history at any time. Memory applies inside the shared pair-selection loop, so
"memory on/off" is one flag across every policy rather than a separate policy —
which is what makes the two arms comparable.

A journal and a hand-played session are the same corpus seen from two angles, so
both go through that one fold. Anything that can name the pairs it tried and what
they returned is a corpus; `projectMemory` and `memoryFromSessions` differ only
in how they get there.

Dead pairs are keyed on `results`, not `fresh`: freshness is relative to the run
that recorded it, so a pair returning something that run already knew is
productive, not dead.

**Invariants are declared and checked against recorded history.** Three of them —
no duplicate discoveries, one tried pair per attempt, attempts within budget —
run through the framework's own `replayAndVerify` over a real journal rather than
a checker written here. A deliberately failing invariant is asserted too, so a
green suite cannot mean "invariants are never evaluated".

**Determinism is tested, not assumed.** `test/determinism.test.ts` asserts that
two runs of one seed produce a byte-identical journal, that state is a pure fold,
that the table hash is pinned, and that the aggregate and the offline engine play
the same game. The first test also asserts journal length, because an empty
journal compares equal to itself and would pass vacuously.

**Policies may not read the table.** They see only the run's own history and the
journal-derived prior. `oracle` deliberately breaks this and is labelled a
ceiling rather than a baseline.

**A person is a player, not a citation.** The terminal game records every attempt
in the same shape the agent produces — pair, results, what was fresh, whether it
repeated — and `memoryFromSessions` projects those recordings into the same prior
the journal produces. So human play is a corpus the agent can start from
(`--seed-from-humans`), and a played session is a baseline measured under this
protocol rather than quoted from a paper. Repeated pairs still cost an attempt,
because they cost a human one.

The five sessions in `data/sessions/` are UI smoke tests — ten attempts between
them — so they move the memory arm by 0.3 elements and prove only that the wiring
works. A real human baseline needs someone to actually sit down and play.

## Development

```bash
pnpm install
pnpm run play                              # play it yourself, 158 attempts
pnpm run play --budget 60 --assist         # shorter, hide pairs already tried
pnpm run play --policy empowerment --seed 7  # watch a policy instead
pnpm run offline                           # baselines, no runtime, no API
pnpm test                                  # determinism
pnpm run bench                             # two-arm bench -> results-alchemy.json
pnpm run q4                                # do evaluators agree with the truth?
pnpm run bench --seed-from-humans          # memory arm starts from played sessions
pnpm run bench:semantic 3 158              # live TypeSafe, three arms
pnpm run bench:semantic --replay           # verify saved report, zero API calls
```

Playing it yourself is not a novelty: it produces a human number under exactly
this protocol and this table, which is the controlled comparison the quoted 51
is not. `play` uses the offline engine and writes no journal — use `bench` for
those.

`--assist` hides pairs you have already tried. It is off by default on purpose:
agents track that for free, the humans in the reference study did not, and
turning it on quietly makes the two numbers incomparable.

`@lambda-house/teob-ts` is linked from a sibling checkout (`link:../teob-ts`) so
framework changes are visible without publishing. Switch to a version or a
pinned git SHA once the framework release carries what this repo needs; for a
bench, pinning by SHA is a feature — results stay tied to an exact commit.

## Data

`data/` holds recipe tables scraped from a commercial game, plus recorded play
sessions, and is **not committed**. Two independent dumps were cross-checked before use and agreed on
3,393 of 3,426 edges. The 720-element table is the working one; it matches the
element count in the Brändle dataset, which keeps the human figure comparable.

## TypeSafe experiment

Put `TYPESAFE_API_KEY` (or `ALCHEMY_API_KEY`) in `.env`; only the live model
command loads it. Requires Node 22+. The integration uses native `fetch`, the
[HTTP API](https://docs.typesafe.ai/api), and the pinned `jev-1.13.0` model.
No SDK or additional dependency is required.

Each turn takes the top 12 legal, untried pairs from the empowerment policy.
One request asks an independent Noul question per pair: would it produce an
element outside the current inventory? The highest probability wins; ties keep
the original shortlist order. The model sees the inventory and candidates,
never the recipe table. Edit the question in `src/judge.ts`.

Three arms use matching seeds and attempt budgets: model without memory, model
with journal-derived memory between games, and model without memory on shuffled
names. Shuffling fixes the four starting elements so reachability is preserved.
Tests verify that the heuristic gets identical discovery counts in both worlds.

`results-semantic.json` records game scores, correlation and Brier error against
the true outcome of **every** shortlisted pair, the shortlist's oracle ceiling,
and the unreranked first candidate's hit rate on those same situations. This
separates candidate coverage from ranking quality. The live trajectories differ;
same-shortlist metrics compare decisions with the inputs held fixed.

Request counts, token usage, request latency and journal bytes are included. Estimated
cost uses the [published input-token price](https://docs.typesafe.ai/models)
of $0.042/M tokens; it is not an invoice. Timestamped journals remain under the
ignored `data/` directory. A fresh API call need not reproduce a previous answer;
offline replay uses recorded responses and verifies the resulting actions,
outcomes, state invariants and report without inference. It is not a simulation
of a different policy's entire future trajectory.

Measured on 2026-09-19, seeds 1–3, 158 attempts per game:

| Policy | Elements per game | Mean |
|---|---|---:|
| Empowerment | 43, 43, 43 | 43.0 |
| Empowerment + memory | 43, 54, 58 | 51.7 |
| TypeSafe | 39, 38, 40 | 39.0 |
| TypeSafe + memory | 38, 49, 54 | 47.0 |
| TypeSafe, shuffled names | 43, 43, 42 | 42.7 |

Memory baseline uses the matching first three games of `results-alchemy.json`.
The model run used 1,422 requests, with estimated input cost **$0.0735**.
All three journals reproduced `results-semantic.json` with zero API calls.

This question/model/shortlist combination did **not** improve the agent. Without
memory, a useful pair was available on 98.5% of shortlists, but the model picked
one on 22.2%; the first heuristic candidate succeeded on 27.2% of those same
states. Its scores correlated with truth at only r = 0.061. Shuffled names also
scored higher than real names. These three seeds do not establish general model
performance, but they provide no evidence of useful semantic ranking here.

## Not yet here

- Evidence that a model improves this task across a larger, held-out seed set.
  The live bench measures this; adding a model does not guarantee improvement.
- An attempt budget spent through an external ledger, which is how this bench
  would exercise exactly-once effects. Stage 2 has landed upstream, so this is
  now implementable; it duplicates the agent bench's `R4` in shape, so it is
  still last.
- A real human baseline. The machinery records and projects sessions; what is
  missing is played games long enough to mean anything.
