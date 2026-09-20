---
name: mutara
description: Integrate Mutara into a project to improve agent strategies through measured experiments, versioned decisions, and TEOB recovery. Use when adding self-learning, adaptive prompts, retrieval or tool-selection strategies, or connecting the Mutara library. Does not train model weights.
---

# Mutara

Mutara is a TypeScript/ESM library over TEOB. The host supplies candidate strategies,
execution, grading and an acceptance rule. Mutara journals the experiment, reserves
budgets, adopts accepted candidates and supports recovery and rollback. There is
no built-in LLM, benchmark dataset, production deployment, or weight training.

## Start with the host project

Inspect its agent entrypoint, strategy configuration, existing evaluation cases,
dependencies and execution side effects. Identify one configurable behavior to
improve and a measurable outcome. Reuse existing evaluation code. If the task has
no reliable feedback, explain the missing signal before claiming self-learning;
collect observations or build a small evaluation dataset within the authorized scope.

Distinguish the experiment's champion from the application's active strategy.
Implement a clear read/apply point in the host; `learnerHarness` does not update
the host automatically. Preserve the existing strategy as a fallback.

## Locate and install

- If `mutara` is installed, use its public exports and bundled skill references.
- Otherwise find the user's Mutara checkout or tarball. The project is currently
  distributed as a local package, not a verified public npm release. Do not run
  `npm install mutara` expecting this project or invent a registry URL.
- From the checkout: `pnpm install --frozen-lockfile`, `pnpm pack`. In the host:
  `pnpm add /absolute/path/to/mutara-0.1.0.tgz` (or the host's package-manager equivalent).
- Requirements: Node.js 22+, ESM, writable SQLite storage. The package pins the
  published `@lambda-house/teob-ts@0.4.2`; it needs no sibling TEOB checkout.
  Native SQLite installation may require a compiler if no prebuilt binary is available.

The installed package bundles this skill. To find it programmatically, resolve
`mutara`'s entrypoint (`dist/index.js`):
`new URL("../skills/mutara/", import.meta.resolve("mutara"))` locates the skill.
In the checkout the path is `skills/mutara`.

## Implement the integration

Read [references/api.md](references/api.md) for the actual adapter and lifecycle
contract. Copy [assets/adapter.mjs](assets/adapter.mjs) into the host as a runnable
starting point, then replace its classifier, candidate choices, datasets and rule
with the host's task. The template is an offline demonstration, not evidence that
its thresholds or tiny validation sets work for another task.

1. Represent the changeable strategy as finite JSON: prompt revision, retrieval
   settings, tool order, memory selection, or another bounded configuration.
   Use `version`, `digest`, and `validateVersion`; every candidate names its parent.
2. Record behavior-changing implementation artifacts, evaluator/dataset versions,
   model ID and generation settings. A human label alone does not pin code.
   Keep credentials out of plans, artifacts, job inputs and receipts: these persist.
3. Connect `execute` to the existing task runner. Keep evaluation truth out of
   model inputs. Use identical task cases and declared budgets when comparing
   candidate and baseline. Do not let candidates grade themselves.
4. Implement `grade` and `assess` using the host's actual objective and constraints.
   Read [references/evaluation.md](references/evaluation.md) before choosing the
   acceptance rule or claiming a measured improvement.
5. Select recovery semantics according to the executor, not its convenience.
   Use [references/operations.md](references/operations.md) for paid APIs, delayed
   feedback, crash recovery, runtime integration and rollback.
6. Run the experiment offline or in the host's authorized environment. Read its
   champion and connect the configuration to the existing agent entrypoint.
   Do not silently replace a production strategy with an untested candidate.

`propose` is synchronous and receives the complete trial history. For model-generated
proposals, generate and validate a bounded candidate list beforehand and record it
in the plan/artifact, or design a separate journaled proposal workflow if requested.
Do not hide async API calls inside `propose` or use uncaptured random choices.

## Verify and hand over

Exercise the copied adapter on a small real task from the host. Verify one improving
candidate is accepted, a worse one is rejected, invalid outputs fail safely, budgets
stop work, and recovery behaves as declared. Include the host's strategy-application
point in verification, not only a standalone demo.

When changing Mutara itself, run `pnpm typecheck`, `pnpm test`, `pnpm demo` and
`pnpm test:package`. Alchemy is an additional benchmark under `examples/alchemy`
and needs private recipe data; never fabricate or redistribute that dataset.

Report changed files, the configurable strategy, metric and acceptance rule,
baseline/candidate results on held-out cases, cost, recovery mode and how to run
or revert the integration. If no gain was measured, say so. Never present journal
accumulation, candidate generation, or a passing plumbing test as proof of improvement.
