# teob-alchemy

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

Requires Node.js 22+, pnpm, a compatible TEOB-TS checkout at `../teob-ts`
(the package uses a local link), and the private recipe file
`data/cheater_la2.json`. Recipe data is not included in this repository.
Its format is defined in [the table loader](src/game/table.ts).

```bash
pnpm install
pnpm test
pnpm typecheck

# Main benchmark: repeats, candidates per method, attempts, test seeds
pnpm run bench:components 3 24 158 500

# Recompute the saved run and verify its decisions and trajectories
pnpm run bench:components --replay
```

Reports are written to `results-components.json`; SQLite journals stay under
`data/`. Replay requires those local journals, the recipe data and the matching
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

Set `TYPESAFE_API_KEY` or `ALCHEMY_API_KEY` in `.env`, then run:

```bash
pnpm run bench:semantic 3 158          # makes paid API calls
pnpm run bench:semantic --replay       # uses recorded responses; no API calls
```

TypeSafe ranks candidate pairs. The tested model and prompt did not improve
the heuristic: 39 versus 43 elements without memory on three seeds.
The automatic component search above does not use this integration.

## Code and checks

- [Strategy constructor](src/learning/strategy.ts): components and candidate generation.
- [Experiment loop](src/learning/experiment.ts): evaluation, acceptance and recovery.
- [Game engine](src/game/engine.ts) and [memory projection](src/memory.ts).
- [Research notes](AGENT-JOURNAL-HYPOTHESIS.md): original hypothesis and framework findings.

40 tests and TypeScript checks passed. The short benchmark replayed fully.
The full-run audit verified 288 decisions and re-simulated 436 games,
including every accepted comparison.
