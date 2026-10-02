# Tutorial: your first verdict on a Vercel AI SDK agent

In about ten minutes you run Mutara's improvement loop on a tool-calling agent, first on
a stub and then on your own model. At the end you have a verdict: `promote`, `reject` or
`inconclusive`, decided on cases the optimizer never saw.

You need Node.js 22+ and this repository checked out. A model API key is needed only
from step 3.

## 1. Run the agent recipe on a stub

```sh
pnpm install && pnpm build
node examples/vercel-ai/tools.mjs
```

The stub model calls the right tool only when the system prompt names it. You should see:

```json
{
  "before": "Answer the question.",
  "after": "Answer the question. Use get_weather. Use get_time.",
  "accepted": [true, true],
  "gate": { "verdict": "promote", "cases": 9, "baseline": 0, "candidate": 1 },
  "note": "Stub wiring demo; not a measured gain."
}
```

What happened:

- Two rounds of rewrites. Each was accepted because it scored higher on validation
  cases than its parent.
- The final check compared the champion with the initial prompt on 40 fresh cases. It
  stopped after 9 pairs, as soon as the result was clear.
- The run was then repeated with the same `id` and reached the same verdict from the
  journal.

The stub shows the loop, not a gain. Numbers count only from step 3 on.

## 2. Look at what is scored

Open `tools.mjs` and find `score`. It gets the receipt from your agent run, the tool
calls Mutara extracted with `toolCallsOf`, and the case's expected answer:

```js
const score = (receipt, c) => {
  const order = toolSequence(receipt.output.toolCalls, [c.expected.tool]);
  if (!order.score) return order;
  return calledTool(receipt.output.toolCalls, c.expected.tool, { args: { city: c.expected.city } });
};
```

`score` returns `{ score, violation, feedback }`. The reflection model reads `feedback`
on failed train cases. It never sees validation or fresh cases.

## 3. Point it at your model

Create `my-executor.mjs` next to the recipe:

```js
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { buildReflectionPrompt } from "teob-mutara/reflective";
import { usageCost } from "../../skills/mutara/assets/vercel-ai.mjs";

export { generateText };
export const model = openai("gpt-4.1-mini");
export const params = { temperature: 0, maxOutputTokens: 512 }; // AI SDK 4: `maxTokens`
// No `execute`: the run stops at the tool call, which is what gets scored. If your
// tools execute, add `stopWhen` to `params` (AI SDK 4: `maxSteps`); calls from
// every step are scored.
export const tools = {
  get_weather: tool({ description: "Weather for a city", inputSchema: z.object({ city: z.string() }) }),
  get_time: tool({ description: "Local time in a city", inputSchema: z.object({ city: z.string() }) }),
}; // AI SDK 4: `parameters` instead of `inputSchema`

// Required for real runs: without it the recipe uses its stub reflector.
export const reflect = async ({ objective, parentPrompt, failures, parentScores }) => {
  const r = await generateText({ model: openai("gpt-4.1"),
    prompt: buildReflectionPrompt(objective, parentPrompt, failures, parentScores) });
  return { text: r.text, cost: usageCost(r.usage) };
};
```

Then run:

```sh
OPENAI_API_KEY=... node examples/vercel-ai/tools.mjs ./examples/vercel-ai/my-executor.mjs
```

With an executor, the recipe uses `recovery: "manual"`: a paid call that was in flight
during a crash waits for you to reconcile it instead of running twice.

The recipe's cases are toy questions. They exercise your model and your tools, not your
product. Step 4 replaces them.

## 4. Use your own cases

Copy `tools.mjs` into your project and replace:

- `cases`: inputs with expected answers, each marked `split: "train"` or
  `"validation"`. Production logs with known outcomes work well.
- `fresh`: cases kept only for the final check, never used in tuning. A clear
  improvement often resolves in a few dozen pairs. Proving "no worse" needs more: about
  120 pairs for a 0.05 margin on a 0–1 score.
- `INITIAL`: your current system prompt.
- `objective`: one sentence the reflection model reads.
- `implementation`: model IDs, params, tool names and scorer version. Change it, and the
  `id`, whenever behavior changes. Never put credentials here.

## 5. Add a hard rule

A hard rule is something you would roll back for even if quality improved. Return it as
`violation`:

```js
const score = (receipt, c) => {
  const calls = receipt.output.toolCalls;
  const graded = calledTool(calls, c.expected.tool, { args: c.expected.args });
  const cancelled = calls.some((t) => t.name === "cancel_order");
  return { ...graded, violation: cancelled && !c.expected.cancel ? 1 : 0 };
};
```

A candidate with more violations than its parent is never accepted, and the final check
never promotes one, whatever its score. `router.mjs` shows this with false cancellations.

## 6. Read the verdict and apply it

- `promote`: the champion beat your prompt on fresh cases. Apply it through your own
  config and keep the old prompt for rollback.
- `reject`: keep your prompt.
- `inconclusive`: the fresh cases ran out first. Add fresh cases; do not ship it.

Mutara never changes your production prompt itself.

## Other recipes

| Recipe | Use it when |
|---|---|
| `router.mjs` | Classification with a costly mistake. A false cancellation is a violation. |
| `extract.mjs` | JSON extraction. Also works with `generateObject` through `createObjectRunner`; schema failures count as violations. |
| `cost-down.mjs` | Moving to a cheaper model. Two arms (prompt as-is, tuned prompt) are checked against the expensive model with a margin. For real prices and resume use `examples/cost-down/run.mjs`. |

Every recipe runs on a stub without keys and accepts an executor module as its first
argument. `router.mjs` and `extract.mjs` take the same `my-executor.mjs` as step 3 and
ignore `tools`:

```sh
OPENAI_API_KEY=... node examples/vercel-ai/router.mjs ./examples/vercel-ai/my-executor.mjs
```

`cost-down.mjs` takes two model setups instead. Create `my-cost-executor.mjs`:

```js
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
export { reflect } from "./my-executor.mjs";

const params = { temperature: 0, maxOutputTokens: 16 };
export const expensive = { generateText, model: openai("gpt-4.1"), params };
export const cheap = { generateText, model: openai("gpt-4.1-nano"), params };
```

The stub cases in these recipes are synthetic (`topic:alpha`, `msg-3`), so a real model
will mostly fail them. Run them to check the wiring, then replace the cases as in step 4.

Reference for all helpers, pricing and recovery:
[skills/mutara/references/vercel-ai.md](../../skills/mutara/references/vercel-ai.md).
