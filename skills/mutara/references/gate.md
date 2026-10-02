# Gate a change: `teob-mutara/gate`

`gate` compares a baseline and a candidate on fresh cases and returns one of three
verdicts. Use it before shipping a new prompt, a model switch, or a champion found
by `optimizeReflective` or `optimize`.

```js
import { gate } from "teob-mutara/gate";

const result = await gate({
  id: "invoice-extract-gpt-to-mini-v1",   // same id after a crash = resume
  storage: "./mutara.db",
  implementation: { prompt: PROMPT, baseline: "big-model", candidate: "small-model", scorer: "exact-fields-v2" },
  cases,                                   // [{ id, input, expected }], never used for tuning
  baseline: (c) => extract(bigModel, PROMPT, c),     // → { output, cost }
  candidate: (c) => extract(smallModel, PROMPT, c),
  score: (output, c) => ({ score: fieldsCorrect(output, c.expected), violation: isJson(output) ? 0 : 1 }),
  scoreRange: 1,                           // max − min score of one case
  minimumGain: -0.03,                      // non-inferiority: candidate may be ≤ 0.03 worse
  concurrency: 4,
});
// result.verdict: "promote" | "reject" | "inconclusive"
```

## Verdicts

- `promote`: the anytime-valid paired test showed `mean(candidate − baseline) > minimumGain`
  at level `alpha` (default 0.05), and the candidate's summed violations are not higher.
- `reject`: the futility bet showed the candidate is not above `minimumGain`, or
  violations increased.
- `inconclusive`: the cases ran out before either. More fresh cases, a wider margin
  or a bigger true difference are needed. Do not ship it as a pass.

`minimumGain: 0` (default) asks for a strict improvement. A negative value asks for
parity within a margin; choose the margin before running, from what the product can
tolerate, never after seeing results.

## How many cases

The test stops as soon as it is decisive (`early: true`), so a clear result is cheap.
Proving parity is the expensive case. Even when both sides give identical scores, the
test needs about

```
n ≈ 6 · scoreRange / margin      (alpha = 0.05)
```

paired cases: ~120 for a 0.05 margin, ~200 for 0.03, ~300 for 0.02 on a 0–1 score.
Real differences and noise need more. Plan the fresh set accordingly.

## What it does not prove

The verdict covers the sampled distribution of cases, the pinned models and the
scorer. It is not a guarantee for every future input, nor regulatory compliance.
Violations are compared as observed totals, not tested. Cases must be independent and
must not have been used to tune either side. Re-running a gate on the same cases after
editing the candidate is adaptive reuse: use a new id and new cases.

## Recovery and cost

Every call is journaled. Re-running with the same `id` and `storage` replays finished
calls without paying for them again; an in-flight call lost in a crash is retried under
`recovery: "repeatable"` (default). `costLimit` reserves cost per call in your runners'
units; a receipt above it fails the gate. Changing `implementation`, the cases or the
options needs a new `id`.

## CLI and CI

`npx teob-mutara gate gate.config.mjs [--out report.json]` runs a config module whose
default export is the options above (or a function returning them). Exit codes: 0
promote, 1 reject, 3 inconclusive, 2 error. With `GITHUB_STEP_SUMMARY` set it writes a
Markdown table.

GitHub Actions, after installing the repository's dependencies:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci
- uses: vadimchirkov/mutara@main
  with:
    config: evals/gate.config.mjs
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Keep the journal (`storage`) as a build artifact or cache to resume a cancelled job.
Never run paid gates on pull requests from forks: they would spend your keys on
untrusted code.

## Vercel AI SDK runners

Any async function returning `{ output, cost }` is a runner:

```js
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const extract = (model, system) => async (c) => {
  const r = await generateText({ model: openai(model), system, prompt: c.input.text, temperature: 0 });
  return { output: r.text, cost: r.usage.totalTokens };   // or dollars from your price table
};
```

The same runner shape works as `run` in `optimizeReflective` (it receives the prompt
first: `run: (prompt, c) => extract("gpt-4.1-mini", prompt)(c)`).

Full worked example with an optimizer step before the gate:
[examples/cost-down](https://github.com/vadimchirkov/mutara/tree/main/examples/cost-down).
