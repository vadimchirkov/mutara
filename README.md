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

## What this measures, and what it does not

The lift above is **recall, not generalisation**. By game ten the agent has
tried ~1,580 pairs and remembers which of them produced something; it is
replaying its own discoveries, not reasoning about elements it has never
combined. That is a real and useful form of self-improvement — it is what the
journal buys for free — but it is not world knowledge.

The gap between 79 and the oracle's 167 is where world knowledge would live. A
semantic judge scoring *untried* pairs is the next step, and the baselines above
are the bar it has to clear: beat 42.7 to be worth its cost, beat 51 to beat a
person. That step needs a model; everything in this repo today runs offline.

The human median is quoted for orientation, not as a controlled comparison:
Brändle's participants played the real game in a UI, where 158 was their mean
number of attempts rather than a hard cap.

## Layout

```
src/game/table.ts      recipe table, content-hashed; name-shuffling ablation
src/game/policies.ts   pair-selection policies, pure, journal-derived
src/game/engine.ts     game state and the single pure step
src/aggregate.ts       the game as a TEOB aggregate: one entity per game
src/memory.ts          journal -> prior projection (the hypothesis, in one file)
src/provenance.ts      hashes of the policy code and the prior, for the journal
src/harness.ts         SQLite runtime wiring
src/offline.ts         baselines with no runtime at all
src/play.ts            the playable terminal game, and policy playback
src/sessions.ts        hand-played sessions: record, load, project
src/ui/sprites.ts      8x8 pixel sprites in half-block characters
src/run.ts             the two-arm bench
test/determinism.test.ts
test/snapshot.test.ts
test/aggregate-properties.test.ts
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

**`decide` performs no side effects.** Every step is pure, which is why this
runs on today's framework instead of waiting for effect kinds (Stage 2 of the
roadmap). The judge, when it arrives, will be the first effect in the system —
and the first thing that needs at-most-once handling.

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
its behaviour, which is the safe direction to be wrong in.

**State is JSON-safe by construction.** Arrays and plain objects, no `Map` or
`Set` anywhere in `GameState`. That is the F9/F10 defect — a `Map` in aggregate
state is silently erased by `JSON.stringify` at the first snapshot, and nothing
detects it at recovery.

**Memory is a projection, not a store.** `projectMemory` folds recorded attempts
into a prior: pairs proved dead are skipped, pairs proved productive are
preferred. It holds no state of its own and can be deleted and rebuilt from the
journal at any time. Memory applies inside the shared pair-selection loop, so
"memory on/off" is one flag across every policy rather than a separate policy —
which is what makes the two arms comparable.

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
pnpm run bench --seed-from-humans          # memory arm starts from played sessions
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

## Not yet here

- A semantic judge over shortlisted pairs (needs a model).
- The name-shuffling ablation, wired but unused: it only means something once a
  judge exists, since it tests whether the judge is using semantics at all.
- An attempt budget spent through an external ledger, which is how this bench
  would exercise exactly-once effects. It duplicates the existing agent bench's
  `R4` in shape, so it is last, and it waits for Stage 2.
- A real human baseline. The machinery records and projects sessions; what is
  missing is played games long enough to mean anything.
