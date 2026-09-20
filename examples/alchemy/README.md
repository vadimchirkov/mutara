# Alchemy — Mutara benchmark

A benchmark for agents that learn from past games, built on
[TEOB-TS](https://github.com/lambda-house/teob-ts).

The agent plays Little Alchemy 2: combine two elements to discover more.
Each game starts with water, fire, earth and air. A fixed recipe table checks
the answers; the agent cannot read it.

## How improvement works

There are two kinds of learning:

- **Memory:** recorded attempts tell the agent which pairs failed and which
  worked. It avoids known failures and prefers productive pairs.
- **Strategy search:** the agent tests different ways to choose its next pair.
  It can add or remove components, change weights, and switch behavior during
  a game.

The constructor combines five components: past productivity, rarely used
ingredients, recently discovered elements, current-game success rate and random
exploration. Components become available gradually. Their combinations are
generated and tested automatically; a new kind of component still needs code.

Each experiment freezes memory from three warmup games. A candidate replaces
the current strategy only if it gains at least one element on average on both
the training and validation sets, and wins most validation games. Final test
games stay outside this search.

TEOB records proposals, results, decisions and strategy versions in SQLite.
The journal supports recovery and repeatable checks. This loop runs offline;
it does not train model weights or call TypeSafe.

## Reusable learning layer

[The learning engine](../../src/engine.ts) owns the TEOB lifecycle;
[the Alchemy adapter](src/learning/experiment.ts) supplies candidate generation,
four paired evaluation batches and the existing acceptance rule. Other tasks
can implement `Adapter` and use `learnerHarness(path, adapter)` without importing
Alchemy. A synthetic scoring task exercises that boundary in
[the engine tests](../../test/self-learning.test.ts).

An adapter defines its implementation artifact, version validation, execution
and cost limits, jobs, executor, grader and acceptance decision. The engine
records each request before executing it, then saves its receipt and observation
separately. A grader may return `null` and receive feedback later through an
`observed` command. Finished experiments can roll back to an accepted version
with a recorded reason. Core and adapter identities are checked before resuming.

Recovery is explicit: `repeatable` permits re-running safe simulations;
`idempotent` requires the executor to deduplicate using `job.id`; `manual` blocks
uncertain execution until a receipt is reconciled through `received`. Execution
limits count logical jobs, not transport retries. Executors must enforce each
job's cost reservation; an invalid or excessive receipt blocks the experiment.
Use globally unique experiment IDs when executors share an idempotency store.

[Version helpers](../../src/version.ts) hash finite JSON artifacts.
[The optional confidence gate](../../src/decision.ts) uses a one-sided
Hoeffding bound and a multiple-comparison penalty. It requires independent cases
and fresh holdout data for adaptive proposals. Alchemy keeps its original
heuristic gate; reusing its small validation set does not provide that statistical
guarantee. Final test seeds remain separate.

The extracted engine uses a new journal schema. Start new experiments in a new
database; old journals and reports require their recorded code revision. There
is no automatic migration of earlier experiment journals.

## Results

Measured on 2026-09-19: three independent searches, 24 candidates per method,
158 attempts per game, and 500 separate test seeds per search.
Each variant was tested on 1,500 games.

| Variant | Mean known elements |
|---|---:|
| Fixed strategy, no memory | 42.46 |
| Fixed strategy with memory | 63.90 |
| Search over three numeric weights | 66.93 |
| Random search over those weights | 66.41 |
| Automatic component search | **74.54** |
| Random component combinations | 72.98 |

Component search improved on numeric search in all three repetitions.
Its best game reached 76 elements. Scores include the four starting elements.
The run used 4,608 search games, nine warmup games and 9,000 final test games,
with zero API calls.

These results cover one recipe table. They do not establish improvement on
other worlds or tasks. Random combinations beat component search in one
repetition, so the best search method remains unsettled.

Full candidate histories, comparisons and costs:
[component results](results-components.json).
Earlier experiments: [memory](results-alchemy.json),
[numeric search](results-learning.json), [TypeSafe](results-semantic.json).

## Run locally

Run these commands from the Mutara repository root. Requires Node.js 22+, pnpm,
and the private recipe file `examples/alchemy/data/cheater_la2.json`. TEOB is
installed from npm. Recipe data is not included in this repository or package.
Its format is defined in [the table loader](src/game/table.ts).

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck

# Main benchmark: repeats, candidates per method, attempts, test seeds
pnpm run bench:components 3 24 158 500

# Recompute the saved run and verify its decisions and trajectories
pnpm run bench:components --replay
```

Reports are written to `examples/alchemy/results-components.json`; SQLite journals
stay under `examples/alchemy/data/`. Replay requires those local journals, the recipe data and the matching
implementation. Published reports alone are insufficient. Use `--output=path`
to keep a separate report.

Other commands:

```bash
pnpm run play                         # play in the terminal
pnpm run offline                      # fixed-policy baselines
pnpm run bench                        # memory versus no memory
pnpm run bench:learning 3 12 158 500    # numeric strategy search
pnpm run q4                           # compare evaluators with recipe truth
```

## Optional TypeSafe experiment

Set `TYPESAFE_API_KEY` or `ALCHEMY_API_KEY` in `examples/alchemy/.env`, then run:

```bash
pnpm run bench:semantic 3 158          # makes paid API calls
pnpm run bench:semantic --replay       # uses recorded responses; no API calls
```

TypeSafe ranks candidate pairs. The tested model and prompt did not improve
the heuristic: 39 versus 43 elements without memory on three seeds.
The automatic component search above does not use this integration.

## Code and checks

- [Strategy constructor](src/learning/strategy.ts): components and candidate generation.
- [Learning engine](../../src/engine.ts): execution, feedback, recovery and rollback.
- [Alchemy adapter](src/learning/experiment.ts): evaluation and acceptance.
- [Game engine](src/game/engine.ts) and [memory projection](src/memory.ts).

53 tests and TypeScript checks passed after extracting the learning engine.
On 2026-09-20 the full component benchmark was rerun with the same protocol:
all 288 candidate decisions, 4,608 search games and 9,000 test games matched the
original results, including trajectory hashes. Version IDs changed with the
implementation; configurations, decisions, scores and costs did not. Component
search still averaged 74.54 elements versus 63.90 with fixed strategy and memory.

The short benchmark replayed every receipt, decision and trajectory. Replay also
rejected a deliberately altered receipt in a separate copy of its journal.
All checks used zero API calls. Local reports are
`data/results-components-transfer.json`, `data/results-transfer-smoke.json` and
`data/results-transfer-verification.json`; these generated files are not committed.

```bash
pnpm run bench:components 3 24 158 500 --output=data/results-components-transfer.json
pnpm run bench:components 1 2 30 8 --output=data/results-transfer-smoke.json
pnpm run bench:components --replay --output=data/results-transfer-smoke.json
```
