# Mutara

**Try agent configurations. Measure them. Keep accepted improvements.**

Mutara helps an agent try new strategies, measure the result, and keep
successful changes. For example: adjusting a prompt, search parameters, tool
ordering, or memory selection. The application defines what can change and how
to evaluate quality; Mutara runs the experiment and stores its history on TEOB.

You supply the task runner and quality measurements. Mutara supplies candidate
search, accept/reject decisions, budget accounting and a recoverable SQLite
journal through TEOB. It does not train model weights or update your production
agent automatically. Rejected candidates leave the current strategy in place.

```text
current strategy → candidate → execution → evaluation → accept / reject
                                      ↓
                          journal, budget, recovery
```

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

Requires Node.js 22+ and pnpm. Dependencies install from npm; a sibling TEOB
checkout is not required. For SQLite, a system compiler is needed when no
prebuilt binary module is available.

```bash
pnpm install --frozen-lockfile
pnpm demo
```

The demo tunes a small classifier threshold. It accepts two improvements,
rejects a degradation, and changes the threshold from `0.9` to `0.5`. Fully
local, no API keys or paid requests. This is a connectivity check, not proof
of quality on real tasks.

## Install in your project

From the Mutara checkout, build an archive:

```bash
pnpm pack
```

In your application directory:

```bash
pnpm add /absolute/path/to/mutara/mutara-0.1.0.tgz
```

The package is local and not published yet; `pnpm add mutara` is not a verified
way to install this project. It includes ESM JavaScript, TypeScript declarations
and the agent skill. Private Alchemy recipes, journals and `.env` are excluded.

## Choose an API

| Need | Use |
|---|---|
| Tune numeric parameters or a fixed list of prompt/tool variants | `optimize` from `mutara/optimizer` |
| Same search, with manual recovery, rollback or a custom wait timeout | `createOptimizer` from `mutara/optimizer` + `learnerHarness` from `mutara/sqlite` |
| Custom candidate generation, hard quality gates or delayed evaluation | `Adapter` from `mutara` + `learnerHarness` |

All three use the same experiment engine. The built-in optimizer uses seeded
random search: it samples each parameter independently, then compares the
candidate against the current champion. It does not invent prompts or tools.

## Tune parameters

Describe a parameter space and measured objective. `optimize` synthesizes the
same adapter used by the core; one experiment owns its history, budget and
recovery. This local deterministic example uses an explicit heuristic decision:

Save as `optimize.mjs` in your application and run `node optimize.mjs`:

```js
import { optimize } from "mutara/optimizer";

const execute = async (config) => ({
  output: { error: (Number(config.x) - 1) ** 2 },
  cost: 0,
});
const result = await optimize({
  id: "quadratic-v1",
  space: { x: { type: "float", min: -10, max: 10, initial: 5 } },
  metrics: [{ name: "error", direction: "lower", weight: 1 }],
  implementation: { execute: execute.toString() }, // self-contained pure function
  execute,
  recovery: "repeatable",
  decision: { mode: "heuristic" },
  budget: { trials: 25 },
  storage: "./optimizer.db",
});
console.log(result.champion); // Plain configuration, e.g. { x: ... }
console.log(result.totalTrials, result.executions, result.spent);
```

Reopen with the same ID and options to resume. Use a new ID for a different
experiment. This example proves wiring, not gains on an application task.

See the [optimizer contract and examples](skills/mutara/references/optimizer.md)
for parameter types, decision modes, cost planning, recovery and defaults.

## Customize the experiment

Copy the [ready-made adapter](skills/mutara/assets/adapter.mjs) into your
application and replace its task, data, candidates, and acceptance rule with
yours. Then:

```js
import { learnerHarness } from "mutara/sqlite";
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

The adapter describes six things: strategy configuration, candidate
generation, task execution, result evaluation, acceptance rule, and limits.
Full [API contract](skills/mutara/references/api.md),
[evaluation methodology](skills/mutara/references/evaluation.md), and
[recovery/rollback](skills/mutara/references/operations.md) are in the skill
references.

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
`node_modules/mutara/skills/mutara`.

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

- `src/` — library; public imports: `mutara`, `mutara/sqlite`, `mutara/optimizer`.
- `examples/` — game starters (tictactoe, connect4, pig, kuhn), alchemy benchmark, minimal integration.
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
