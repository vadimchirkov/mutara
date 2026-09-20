# Declarative Optimizer Layer

A declarative layer on top of the existing Mutara core. The consumer describes
a parameter space, metrics, and an execution function — Mutara explores,
tests, and accepts improvements in a continuous loop.

## Approach

Evolutionary extension of the current core (approach A). Three new files, core
unchanged. Alchemy continues to work on the low-level `createLearner` +
`Adapter` API.

## Architecture

```
┌─────────────────────────────────────────┐
│  Declarative API  (mutara/optimizer)    │  ← new
│  space + metrics + execute + budget     │
├─────────────────────────────────────────┤
│  Search strategies  (search.ts)         │  ← new
│  random (v1), grid/bayesian (later)     │
├─────────────────────────────────────────┤
│  Multi-metric decision  (multi-metric)  │  ← new
│  weighted composite → boundedDecision   │
├─────────────────────────────────────────┤
│  Core engine  (createLearner + TEOB)    │  ← unchanged
│  version, journal, recovery             │
├─────────────────────────────────────────┤
│  Storage  (SQLite / memory)             │  ← unchanged
└─────────────────────────────────────────┘
```

The declarative layer is a pure wrapper: it synthesizes an `Adapter` from the
declarative description, and manages epochs and budget.

## API

```ts
import { optimize } from "mutara/optimizer";

const result = await optimize({
  space: {
    temperature: { type: "float", min: 0, max: 2, initial: 1 },
    maxTokens:   { type: "int",   min: 100, max: 4000, initial: 1000 },
    style:       { type: "enum",  values: ["concise", "detailed"], initial: "concise" },
  },
  metrics: [
    { name: "quality",  direction: "higher", weight: 1 },
    { name: "cost_usd", direction: "lower",  weight: 0.3 },
  ],
  execute: async (config) => {
    const r = await callLLM(config);
    return { quality: judge(r), cost_usd: r.cost };
  },
  samplesPerTrial: 5,
  budget: { trials: 100 },
  storage: "./optimizer.db",
});

console.log(result.champion);
// { temperature: 0.7, maxTokens: 2000, style: "detailed" }
```

### Contract

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `space` | `Record<string, Dimension>` | yes | Parameters with types, ranges, and initial values |
| `metrics` | `Metric[]` | yes | What to measure, direction, weight |
| `execute` | `(config) => Promise<Record<string, number>>` | yes | Execution: config → metrics |
| `samplesPerTrial` | `number` | no (default 1) | Repetitions per candidate for statistical significance |
| `budget` | `{ trials: number }` | no (default 50) | How many candidates to try |
| `strategy` | `"random" \| SearchFn` | no (default "random") | Search strategy |
| `storage` | `string` | no (default ":memory:") | Path to SQLite database |

### Space types

```ts
type FloatDim = { type: "float"; min: number; max: number; initial: number };
type IntDim   = { type: "int";   min: number; max: number; initial: number };
type EnumDim  = { type: "enum";  values: string[]; initial: string };
type Dimension = FloatDim | IntDim | EnumDim;
```

### Return value

```ts
interface OptimizerResult<C> {
  champion: C;
  history: TrialSummary[];
  totalTrials: number;
  epochs: number;
}

interface TrialSummary {
  config: Record<string, unknown>;
  metrics: Record<string, number>;  // averaged across samples
  accepted: boolean;
  reason: string;
}
```

## Search strategies

v1: random search only. Samples uniformly from the space, ignoring history.
For small budgets (<100 trials) random is competitive with bayesian
optimization.

The strategy is implemented as `propose(champion, history, plan)` — matching
the `Adapter.propose` signature exactly. Extension: the user passes
`strategy: (champion, history, space) => config` for custom logic.

Grid and bayesian are separate tasks, added when random hits practical limits.

## Multi-metric decision

Weighted composite → single score → `boundedDecision`.

For each sample i:
1. Compute difference per metric j: `diff_j = candidate_j - baseline_j`
2. Flip sign for `direction: "lower"`
3. Weighted sum: `composite_i = Σ(weight_j × diff_j_i)`
4. Array of `composite[]` → `boundedDecision({ differences: composite, ... })`

`boundedDecision` parameters:
- `alpha`: 0.05 (default)
- `minimumGain`: 0 (accept any statistically significant improvement)
- `range`: estimated from the initial configuration samples (first candidate
  vs initial, range = max − min of observed composites for that pair)
- `comparisons`: `budget.trials` (Bonferroni over the entire budget)

The user controls inter-metric scaling via `weight`. If quality ∈ [0, 1] and
latency ∈ [0, 5000], latency needs weight ~0.001.

## Continuous mode

The current core limits experiments to 100 rounds. The declarative layer
works around this by chaining epochs:

```
while (totalTrials < budget.trials) {
  epochRounds = min(50, budget.trials - totalTrials)
  experiment = createLearner(synthesizedAdapter)
  start(epoch_N, { initial: currentChampion, rounds: epochRounds })
  result = wait(epoch_N)
  currentChampion = result.champion
  totalTrials += result.trials.length
}
```

Each epoch is a separate `createLearner` with its own TEOB journal. The
champion carries over as `plan.initial` for the next epoch. The core is
unaware of continuity.

For unbounded mode: `budget: { trials: Infinity }` + external `.stop()`.

## Adapter synthesis

The declarative layer creates an `Adapter` from the description:

| Adapter method | Source |
|---|---|
| `propose` | Search strategy + space definition |
| `jobs` | N identical jobs (N = samplesPerTrial), input = config |
| `execute` | Calls user's execute(config), returns as Receipt |
| `grade` | Extracts metrics from Receipt.output → Observation |
| `assess` | Composite differences → boundedDecision |
| `limits` | From budget |
| `recovery` | `"repeatable"` (execute is safe to retry) |
| `implementation` | Hash of space + metrics description |

`Version` is generated via `version(config, implementationId, parentId)`.

## File structure

```
src/
  engine.ts          — unchanged
  version.ts         — unchanged
  decision.ts        — unchanged
  sqlite.ts          — unchanged
  index.ts           — unchanged (core exports)
  optimizer.ts       — NEW: optimize(), adapter synthesis, epoch loop
  search.ts          — NEW: randomSearch
  multi-metric.ts    — NEW: compositeDecision
```

New export in `package.json`:
```json
"./optimizer": {
  "types": "./dist/optimizer.d.ts",
  "import": "./dist/optimizer.js"
}
```

## Tests

`test/optimizer.test.ts`:
- Quadratic function: optimizer finds a config closer to the minimum than initial
- Budget: does not exceed `budget.trials`
- Multi-metric: two conflicting metrics → finds a compromise
- Epochs: budget > 50 → verify champion carries between epochs

No mocks, execute = pure math.

## Out of scope for v1

- Grid / bayesian search — add when random hits limits
- Server / HTTP API — add when a non-JS consumer appears
- Custom evaluate / LLM-judge — low-level API covers this
- UI / dashboard — history is available via result.history
- Automatic weight selection — user sets weights explicitly
- Pareto optimization — weighted composite covers v1
