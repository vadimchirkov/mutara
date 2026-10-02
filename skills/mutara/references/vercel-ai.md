# Vercel AI SDK template

Copy `assets/vercel-ai.mjs` into the host. No `ai` dependency in Mutara: inject your
`generateText` (or a stub in tests). Pin everything behavior-changing in `implementation`;
never credentials.

## Strategy

- Prompt: string or up to 20 named components (`{ system, format }`) for `optimizeReflective`.
- Numeric settings: `optimize` space, e.g. `{ temperature: { type: "float", min: 0, max: 1, initial: 0 }, topP: { type: "float", min: 0.1, max: 1, initial: 1 } }`.
- Fixed choices (model, tool set): `enum` dimension or fixed candidates via `gate`/prompt-gate pattern.
- `implementation`: `{ taskRunner, evaluator, reflector, modelIds, params, pricePerM, toolSchemas }` as finite JSON.

## Wiring

```js
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createTextRunner, exactScore } from "./vercel-ai.mjs";

const model = openai("gpt-4.1-mini");
const run = createTextRunner({ generateText, model, params: { temperature: 0, maxOutputTokens: 512 } }); // AI SDK 4: maxTokens
// reflective
await optimizeReflective({ id: "support-v1", storage: "./mutara.db", implementation,
  initialPrompt: "Classify.", objective: "…", cases, run,
  score: (receipt, c) => exactScore(receipt.output, c.expected),
  reflect: async ({ parentPrompt, failures, objective, parentScores }) => {
    const r = await generateText({ model: openai("gpt-4.1"), system: "Rewrite the prompt.",
      prompt: buildReflectionPrompt(objective, parentPrompt, failures, parentScores),
      temperature: 0.7 });
    return { text: r.text, cost: r.usage.totalTokens };
  },
  recovery: "manual", budget: { cost: 5_000_000 } });
// gate a cheaper model: same runner shape, `minimumGain: -0.03`, fresh cases only.
```

Cases: `{ id, split: "train"|"validation", input: { text }, expected }`.
`run` sees only `input`; `score` sees `expected`. Keep `finalCases`/gate cases disjoint;
~120 fresh 0–1 cases for margin 0.05, ~200 for 0.03.

## Recipes (`examples/vercel-ai/`)

All run on stubs; pass an executor module (`{ generateText, model, params }`) for real models.

- **Extraction** (`extract.mjs`): hidden format conventions, `jsonFieldsScore`
  (non-JSON = violation), reflector learns conventions from `feedback`. Needs both
  splits; gate champion vs initial on fresh cases.
- **Router** (`router.mjs`): `violation` = false cancellation. Accuracy alone never
  promotes a trigger-happy candidate. Same pattern as `examples/prompt-gate/`.
- **Cost-down** (`cost-down.mjs`): tune the cheap prompt, then gate naive and tuned
  arms vs expensive with `minimumGain: -margin`. Stub verdicts prove wiring only.
  For real prices/resume use `examples/cost-down/run.mjs`.
- **Tool agent** (`tools.mjs`): selection, args and order via `calledTool`/`toolSequence`.

Executor modules for real runs must also export `reflect`; otherwise the recipe keeps
its stub reflector. Human-facing walkthrough: `examples/vercel-ai/README.md`.

## generateObject

For schema-enforced extraction use `createObjectRunner` + `objectScore` instead of
parsing JSON out of text. A `NoObjectGeneratedError` carries the raw text and usage:
the runner returns a gradable `{ output: null }` receipt (violation in scoring),
while transport errors still throw and block for reconciliation:

```js
import { createObjectRunner, objectScore } from "./vercel-ai.mjs";
const run = createObjectRunner({ generateObject, model, schema, params: { temperature: 0 } });
// score: (receipt, c) => objectScore(receipt.output, c.expected)
```

Pin the schema as JSON in `implementation`; the handle itself stays out of the journal.

## Tool calls

`generateText` results already flow into `trace` via `toolCalls`/`steps`.
For selection/args/order assertions, return structured output from `run` and score it:

```js
import { toolCallsOf, calledTool, toolSequence } from "./vercel-ai.mjs";
const run = async (system, c) => {
  const r = await generateText({ model, system, prompt: c.input.text, tools, ...params });
  return { output: { text: r.text, toolCalls: toolCallsOf(r) }, cost: usageCost(r.usage, 0) };
};
// score: calledTool(output.toolCalls, "get_weather", { args: { city } })
//        toolSequence(output.toolCalls, ["get_weather", "book_flight"])
```

See `tools.mjs`. Tool-result error states differ across SDK versions, so assert on
results in host-specific scoring.

## Hard rules for agents

Return forbidden actions as `violation`, never folded into `score`: an irreversible tool
call without a request, a limit exceeded, invalid JSON. Reflective acceptance and `gate`
both reject a candidate whose violations exceed its baseline's, regardless of score.

```js
score: (receipt, c) => ({
  ...calledTool(receipt.output.toolCalls, c.expected.tool, { args: c.expected.args }),
  violation: receipt.output.toolCalls.some((t) => t.name === "cancel_order") && !c.expected.cancel ? 1 : 0,
}),
```

## Pricing

Token costs become USD with `usdCost(usage, prices, modelId)` where `prices` maps
model IDs to `{ input, output }` ($/1M) or `{ blended }`. Pass
`price: { prices, model }` to either runner instead of a blended number.

## Budgets and recovery

Paid calls: `recovery: "manual"` (default), `costLimit` per call, `budget.cost` total,
`pricePerM` for USD or tokens otherwise. `repeatable` only for stubs/local sims.
One runtime owner per experiment; same `id` + `storage` resumes without repaying.
Apply `result.champion` through the host config path; `rollback` on regression.
See `operations.md`, `evaluation.md`, `gate.md`.
