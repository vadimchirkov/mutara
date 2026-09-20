# Mutara

**Self-learning through verifiable strategy changes.**

Mutara helps an agent try new strategies, measure the result, and keep
successful changes. For example: adjusting a prompt, search parameters, tool
ordering, or memory selection. The application defines what can change and how
to evaluate quality; Mutara runs the experiment and stores its history on TEOB.

The name refers to strategy mutation. Mutara does not train model weights and
does not guarantee improvement: if a candidate fails verification, the
previous version remains.

```text
current strategy → candidate → execution → evaluation → accept / reject
                                      ↓
                          journal, budget, recovery
```

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

## Declarative optimizer (planned)

A high-level API where the consumer describes a parameter space, metrics, and
an execution function — Mutara explores, tests, and accepts improvements
automatically:

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
```

See [design spec](docs/specs/2026-09-20-declarative-optimizer-design.md) for
architecture and implementation details.

## Integrating with your project

Build the package in the Mutara directory:

```bash
pnpm pack
```

In your application directory, install the resulting archive:

```bash
pnpm add /absolute/path/to/mutara/mutara-0.1.0.tgz
```

The package is not published yet. `pnpm add mutara` is not a verified
installation method. The package uses ESM and contains JavaScript, TypeScript
types, and the skill. Alchemy recipes, journals, `.env`, and research notes
are excluded.

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
agent, helps find the integration point in a project, choose a metric, write
an adapter, and verify improvement. Includes a working template and
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

- `src/` — standalone library, public entry `src/index.ts`.
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
runs the copied adapter, checks TypeScript imports and package contents.

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

After the local rename, the old path `teob-alchemy` is left as a symlink to
`mutara`, and `data` as a symlink to example data: historical absolute paths
continue to resolve. Git history is preserved; the remote is not renamed and
nothing is published.
