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
and measure the outcome. These are integration ideas; the host supplies the
runner, data and evaluator for each task.

| Use case | What to tune | What to measure |
|---|---|---|
| Prompt selection | Instruction variants, examples, response templates | Task accuracy, instruction compliance, token use |
| Retrieval-augmented generation (RAG) | Chunk size, overlap, top-k, reranking thresholds | Retrieval recall, answer correctness, citation support |
| Search agents | Query templates, source selection, search depth | Relevant results, coverage, latency, request cost |
| Tool use | Predefined tool sequences, routing thresholds, fallback policies | Task completion, invalid calls, execution cost |
| Model routing | Model choices, escalation thresholds, generation settings | Quality, latency, cost per completed task |
| Agent memory | Recall limits, recency weights, summary variants | Relevant recall, task success, context size |
| Planning and multi-step tasks | Planning templates, step limits, verification frequency | Completion rate, wasted steps, recovery rate |
| Coding agents | Repair prompts, context selection, test-selection policies | Held-out tests passed, regressions, execution time |
| Structured extraction | Extraction prompts, parser variants, confidence thresholds | Field accuracy, schema validity, missing values |
| Classification and triage | Decision thresholds, feature weights, routing rules | Precision, recall, false positives, abstentions |
| Customer support | Retrieval settings, response policies, escalation thresholds | Resolution accuracy, unsupported claims, correct handoffs |
| Summarization | Length limits, section templates, source-selection policies | Fact coverage, factual errors, compression ratio |
| Translation and localization | Glossary variants, style prompts, context windows | Meaning preservation, terminology accuracy, reviewer scores |
| Document processing | OCR settings, page segmentation, extraction pipelines | Character/field accuracy, throughput, cost |
| Browser and workflow agents | Navigation policies, wait limits, retry strategies | Task completion, duplicate actions, elapsed time |
| Recommendations and ranking | Ranking weights, retrieval depth, diversity penalties | Relevance on labeled cases, ranking quality, coverage |
| Scheduling and resource allocation | Priority weights, batch sizes, dispatch heuristics | Throughput, deadline misses, resource use in simulation |
| Games and simulations | Policy weights, exploration settings, component choices | Reward, success rate, transfer to unseen scenarios |

Use the optimizer for numeric settings and predefined string choices. Use a
custom adapter for generated strategies, delayed human feedback or mandatory
quality gates. Weighted metrics allow tradeoffs; they cannot enforce a rule
such as “reduce cost only if accuracy never drops.” Evaluate the selected
configuration on separate held-out cases before applying it to the host.

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

Each trial evaluates the champion and candidate on `samplesPerTrial` paired
cases. With 25 trials and the default one case, this example makes 50 executions.
`history` contains each candidate's mean metrics, acceptance flag and reason.

Reopen with the same ID, options and implementation to resume or read the result.
Use a new ID for a different experiment. Trials are bounded to 1–100; there is no
background loop. Keep `storage` for durable recovery; omitting it uses `:memory:`.
This example proves wiring, not gains on an application task.

The example explicitly uses `heuristic`, accepting positive mean gain without
a statistical guarantee. The default is `bounded`: each metric needs fixed
`bounds: { min, max }`, declared before evaluation. Set enough `samplesPerTrial`:
the default of 1 cannot demonstrate a gain at the default confidence level.
`execute(config, { id, sample, costLimit })` receives the same
case index for baseline and candidate, with fresh indices each round. Map these
indices to independent cases; reserve a separate final test set to measure the
selected champion. Weights combine raw metric differences without normalization;
they express tradeoffs, not hard quality constraints.

Executors return `{ output: metrics, cost }`. Set `costLimit` per execution and
`budget.cost` for paid work, and enforce limits in the executor. Recovery defaults
to `manual`; use `idempotent` only when the executor deduplicates by the supplied
ID. Pin executor, evaluator, data and dependency artifacts in `implementation`;
function text alone cannot capture closures or external services.

See the [optimizer contract and examples](skills/mutara/references/optimizer.md)
for parameter types, defaults, cost planning, results and recovery.

## Customize the experiment

Copy the [ready-made adapter](skills/mutara/assets/adapter.mjs) into your
application and replace its task, data, candidates, and acceptance rule with
yours. Then:

```js
import { learnerHarness } from "mutara/sqlite";
import { adapter, plan } from "./adapter.mjs";

const learner = learnerHarness("./learning.db", adapter);
try {
  await learner.start("support-strategy-001", plan);
  const result = await learner.wait("support-strategy-001");
  console.log(result.champion.config);
} finally {
  await learner.close();
}
```

Use a new ID for each new experiment. To resume an existing one, open the same
database and call `state(id)` or `wait(id)` without repeating `start`.
Changing an experiment's champion does not change your application's
configuration by itself.

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

## Structure and checks

- `src/` — library; public imports: `mutara`, `mutara/sqlite`, `mutara/optimizer`.
- `examples/minimal.mjs` — minimal integration.
- `examples/alchemy/` — the original game benchmark, its tests and reports.
- `skills/mutara/` — portable skill and adapter template.
- `test/` — library tests; `scripts/check-package.mjs` — clean install check.

```bash
pnpm typecheck
pnpm test
pnpm demo
pnpm test:package

# Alchemy: requires local private recipes examples/alchemy/data/cheater_la2.json
pnpm bench:components 1 2 30 8 --output=examples/alchemy/data/results-package-smoke.json
pnpm bench:components --replay --output=examples/alchemy/data/results-package-smoke.json
```

`test:package` builds an archive, installs it in a separate temporary project,
runs the copied adapter and optimizer, checks reopening, TypeScript imports
and package contents.

In the historical full Alchemy benchmark, component search yielded **74.54
elements** versus **63.90** for the fixed strategy with memory. This is a
single-task result; for a new application, improvement must be measured
independently.

## Limitations

For paid or external actions, recovery mode is chosen based on executor
guarantees: safe retry, real idempotency, or manual reconciliation. Mutara
verifies reported costs, but the executor must limit spending itself.
Experiment data is stored in SQLite — do not pass access keys into it.

Source TypeScript and built JavaScript have different implementation hashes.
To resume an experiment, preserve the same package, lockfile, and adapter
artifact. There is no automatic migration for old journals.
