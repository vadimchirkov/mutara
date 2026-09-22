# Mutara

**Gated experiment harness — journal every trial, gate every promotion, recover every crash.**

Optimizers generate candidates. Mutara decides whether to keep them.

You bring the candidate source (GEPA, Bayesian optimization, a hand-picked
list, or the built-in random search) and the task runner. Mutara runs each
candidate against pinned cases, applies your acceptance rule, tracks cost,
and journals the decision to a recoverable SQLite store through
[TEOB](https://github.com/lambda-house/teob-ts). A crash mid-trial resumes
from the journal — no lost lesson, no double spend.

```text
generator → candidate → execution → evaluation → accept / reject
                                         ↓
                             journal · budget · recovery
```

Rejected candidates leave the current champion in place. Accepted ones become
the new champion. Mutara does not deploy the champion — it tells you who won.

## Why not Optuna / DSPy / W&B?

| | Optuna | DSPy/GEPA | W&B / MLflow | Mutara |
|---|---|---|---|---|
| Candidate generation | Strong (TPE, BO) | Strong (prompt evolution) | None | Weak built-in; plug in any external |
| Crash recovery | Retry = re-run, cost paid twice | None | None (tracker) | Resumes mid-trial, no double spend |
| Cost accounting | None | None | Logs, doesn't limit | Budget with verification |
| Accept/reject gate | None (best trial) | Internal metric | Manual review | Explicit, configurable |
| Plug external generator | No | No | N/A | Yes (`Adapter`) |
| Language | Python | Python | Python + UI | TypeScript |

Mutara is not a better optimizer — it is the promotion layer that sits between
any optimizer and your production configuration.

## Use cases

Mutara fits tasks where you can change a configuration, run comparable cases,
and measure the outcome. The host supplies the runner, data and evaluator.

| Use case | What to tune | What to measure |
|---|---|---|
| Prompt selection | Instruction variants, examples, templates | Accuracy, compliance, token use |
| RAG | Chunk size, overlap, top-k, reranking | Recall, answer correctness, citations |
| Tool use / model routing | Sequences, thresholds, fallback policies | Completion, cost, latency |
| Games and simulations | Policy weights, components, exploration | Reward, win rate, transfer |
| Coding agents | Repair prompts, context selection, test policies | Tests passed, regressions, time |

Similar pattern applies to extraction, classification, summarization,
scheduling, browser agents, and other measurable tasks.

## Quick start

Requires Node.js 22+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm demo
```

The demo tunes a small classifier threshold. It accepts two improvements,
rejects a candidate that improves training accuracy but regresses on separate
validation cases, and changes the threshold from `0.9` to `0.5`. Fully
local, no API keys or paid requests.

## Install in your project

```bash
pnpm add teob-mutara
```

The package includes ESM JavaScript, TypeScript declarations and the agent
skill.

## Choose an API

| Need | Use |
|---|---|
| Custom candidate generation, hard quality gates or delayed evaluation | `Adapter` from `teob-mutara` + `learnerHarness` |
| Tune numeric parameters or a fixed list of variants with defaults | `optimize` from `teob-mutara/optimizer` |
| Same search, with manual recovery, rollback or a custom wait timeout | `createOptimizer` from `teob-mutara/optimizer` + `learnerHarness` from `teob-mutara/sqlite` |

The `Adapter` is the primary interface — it describes six things: strategy
configuration, candidate generation, task execution, result evaluation,
acceptance rule, and limits. The built-in optimizer synthesizes an adapter
from a parameter space description; it uses seeded random search and is a
convenience shortcut, not the core.

## Bring your own candidates

Copy the [ready-made adapter](skills/mutara/assets/adapter.mjs) into your
application and replace its task, data, candidates, and acceptance rule with
yours:

```js
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, plan } from "./adapter.mjs";

const learner = learnerHarness("./learning.db", adapter);
try {
  await learner.startOrResume("support-strategy-001", plan);
  const result = await learner.wait("support-strategy-001");
  console.log(result.champion.config);
} finally {
  await learner.close();
}
```

`startOrResume` starts a new experiment or resumes an existing one with the
same ID. Use a new ID for a different experiment. Changing an experiment's
champion does not change your application's configuration by itself.

Full [API contract](skills/mutara/references/api.md),
[evaluation methodology](skills/mutara/references/evaluation.md), and
[recovery/rollback](skills/mutara/references/operations.md) are in the skill
references.

For a complete example with fixed external prompt candidates, a validation gate,
a hard quality constraint, and a separate report-only final test, see
[prompt-gate](examples/prompt-gate/README.md). Both stages have resumable journals.

## Tune parameters (shortcut)

When candidates are just numeric ranges or a fixed list, `optimize` builds
the adapter for you:

```js
import { optimize } from "teob-mutara/optimizer";

const execute = async (config) => ({
  output: { error: (Number(config.x) - 1) ** 2 },
  cost: 0,
});
const result = await optimize({
  id: "quadratic-v1",
  space: { x: { type: "float", min: -10, max: 10, initial: 5 } },
  metrics: [{ name: "error", direction: "lower", weight: 1 }],
  implementation: { execute: execute.toString() },
  execute,
  recovery: "repeatable",
  decision: { mode: "heuristic" },
  budget: { trials: 25 },
  storage: "./optimizer.db",
});
console.log(result.champion);
console.log(result.totalTrials, result.executions, result.spent);
```

See the [optimizer contract and examples](skills/mutara/references/optimizer.md)
for parameter types, decision modes, cost planning, recovery and defaults.

## Skill for agents

[skills/mutara/SKILL.md](skills/mutara/SKILL.md) explains the system to an
agent, helps find the integration point, choose between the optimizer and a
custom adapter, set metrics and verify improvement. Includes a working template and
instructions for paid APIs, deferred evaluation, recovery, and rollback.

In Codex you can link to the skill directory:

```bash
mkdir -p ~/.codex/skills
ln -s /absolute/path/to/mutara/skills/mutara ~/.codex/skills/mutara
```

If a skill with that name already exists, do not overwrite it. For a different
agent, copy the **entire** `skills/mutara` directory into its skills folder.
The skill is also included in the installed npm package:
`node_modules/teob-mutara/skills/mutara`.

Example prompt:

> Use $mutara. Connect strategy tuning to this agent. Compare the current and
> new strategies on separate test tasks, show quality and cost.

## Game starters

Four games test different dimensions, all on the same scaffold. No changes to
`src/` — the engine and optimizer are used as a library.

| Game | Dimension | Result |
|---|---|---|
| [Tic-tac-toe](examples/tictactoe/) | MCTS tuning, component search, machine-invented features | 0.47 → 0.83 (component), 0.47 → 0.70 (machine dictionary) |
| [Connect-4 5x5](examples/connect4/) | Transfer to a harder game, component search | 0.53 → 0.745 held-out |
| [Pig](examples/pig/) | Decisions under chance (dice) | 0.47 → 0.755 held-out |
| [Kuhn poker](examples/kuhn/) | Hidden information — **negative result**, then CFR-as-adapter | Greedy search plateaus; CFR through the engine converges to Nash |

Each game's README has methodology, gate design, measured numbers, negative
results, and ceiling analysis.

## Structure and checks

- `src/` — library; public imports: `teob-mutara`, `teob-mutara/sqlite`, `teob-mutara/optimizer`.
- `examples/` — game starters (tictactoe, connect4, pig, kuhn), prompt gate, alchemy benchmark, minimal integration.
- `skills/mutara/` — portable skill and adapter template.
- `test/` — library tests; `scripts/check-package.mjs` — clean install check.

```bash
pnpm typecheck
pnpm test
pnpm demo
pnpm test:package
```

## Limitations

For paid or external actions, recovery mode is chosen based on executor
guarantees: safe retry, real idempotency, or manual reconciliation. Mutara
verifies reported costs, but the executor must limit spending itself.
Experiment data is stored in SQLite — do not pass access keys into it.

Source TypeScript and built JavaScript have different implementation hashes.
To resume an experiment, preserve the same package, lockfile, and adapter
artifact. There is no automatic migration for old journals.
