# Launch kit (not shipped in the npm package)

Drafts only. Nothing here has been sent or posted. Fill the `[…]` parts with measured
numbers before use; do not post before IFBench and cost-down have real results.

## Positioning (one line)

Move your AI workflow to a cheaper model, or ship a new prompt, only when a
significance test on fresh cases says it is not worse. TypeScript, CI-ready, crash-safe.

Do not lead with "prompt optimizer" (crowded: DSPy, GEPA, Ax, Promptfoo, Braintrust
Loop, LangSmith, Adaline) or "provable" (statistics bound error on the sampled
distribution; they do not guarantee future inputs).

## Show HN draft

Title: Show HN: Mutara – ship a cheaper LLM only when a stats test says it's not worse

Body:

> I kept switching models and prompts on gut feeling: run 30 examples, eyeball the
> diff, ship. Mutara replaces that with a gate: give it the current setup, the
> candidate (cheaper model, new prompt, optimizer output), fresh cases and a scorer.
> It runs both sides pair by pair and returns promote / reject / inconclusive from an
> anytime-valid test, so it stops early when the answer is clear. A negative margin
> asks "at most 3 points worse?", which is the question a model migration actually has.
>
> It also has a GEPA-style optimizer that rewrites the prompt from failures before the
> gate. Everything is journaled in SQLite: kill it mid-run and it resumes without
> paying for finished calls again.
>
> Numbers: [cost-down result: naive vs optimized cheap model, cost ratio]. IFBench vs
> dspy.GEPA at equal budget: [result, including if it lost]. Negative results are in
> the repo.
>
> Honest limits: parity needs about 6/margin cases (~200 for 3 points); the verdict
> covers your sampled cases, not every future input.
>
> MIT, TypeScript, `npx teob-mutara gate`. https://github.com/vadimchirkov/mutara

## Design-partner message (template)

Subject: Moving [their workflow] to a cheaper model without a quality regression

> Hi [name], I read [their post / job ad: link]. [One sentence on the exact pain they
> described.] I build Mutara, an open-source TypeScript tool that answers "can we move
> this to a cheaper model?" with a significance test on fresh cases, and tunes the
> prompt for the cheaper model first. On a payment-extraction benchmark it [measured
> result]. I'm looking for two teams to run it on their own logged cases, free, in
> exchange for a short write-up we agree on. Would 20 minutes next week work?

## Who to contact first (from the 2026-10-02 research)

Evidence was found by web research and is not verified by contact. Check that each
post or role is still current before writing.

| Who | Why | Evidence |
|---|---|---|
| Zarif Aziz (Tutero) | Dropped prompt-optimization frameworks: token burn for marginal gains, scores varying across identical configs | https://zarif-aziz.medium.com/automated-prompt-optimisation-why-i-replaced-prompt-optimisation-frameworks-with-a |
| Parv Gatecha | Open-sourced Arbiter because single-point eval scores lack statistical validity | LinkedIn post, 2026-06-26 |
| Egor Lynko | Content agent silently degraded after model/prompt changes | https://yegor.me/posts/put-your-llm-output-under-test/ |
| FurtherAI (insurance, $25M A) | Eval Studio on real submissions; model swaps are routine | furtherai.com |
| GC AI (legal) | Own benchmark, LLM judges, regression detection | gc.ai |
| Hyperbots (finance docs, $9.5M) | Document extraction at volume: per-page cost matters | https://www.hyperbots.com/platform |
| Eloquent AI (fintech, $8.4M seed) | Evals framework for regulated workflows | eloquentai.co |
| Knak | Hiring for eval datasets, regression tracking, model comparisons | https://boards.greenhouse.io/knak/jobs/4732794005 |
| BPM / Caravel | AI practice building regression tests for many clients | https://jobs.lever.co/bpmcpa/6d044664-9c83-4dfc-b175-0766ebd387 |

Searches that surfaced more: `"prompt regression" site:jobs.lever.co`,
`"eval datasets" "prompt tuning" site:boards.greenhouse.io`, `"model migration" "evals"`,
`"system prompt" "stopped working" site:reddit.com/r/LLMDevs`.

## To verify before using

- Exa research reported that OpenAI's Evals become read-only on 2026-10-31 and shut
  down on 2026-11-30, including the dataset-backed prompt optimizer. If true, a
  "migrate off OpenAI Evals" guide is timely. Confirm on OpenAI's own docs first.
- Promptfoo agreed to join OpenAI (announced 2026-03-09); Langfuse joined ClickHouse
  (2026-01-16). Teams wary of vendor-owned eval tools are a natural audience.
