# Autoresearch: where Mutara fits in a Karpathy-style loop

[autoresearch](https://github.com/karpathy/autoresearch) runs an agent overnight: edit
the code, run a fixed-budget experiment, keep the commit if the validation metric beats
the best so far, otherwise `git reset`. Forks apply the same loop to build time, prompts
and business metrics. Two known weak spots: run-to-run noise, and a validation set reused
for every decision ([autoresearch-overfit](https://github.com/travispchen/autoresearch-overfit)
measured +0.019 on validation and -0.0006 on test).

This example asks one question with known ground truth: how many fake improvements does
the keep/discard rule accept, and where does Mutara's `gate` help?

```bash
pnpm build
node examples/autoresearch/simulate.mjs        # 100 seeds x 100 proposals, ~0.3 s, deterministic
```

This is a simulation. It is not a measured gain on a real task.

## Setup

Each proposal shifts the champion's true quality by a hidden delta. The metric is a pass
rate on cases of varying difficulty, so every score is noisy. The proposal mixes were fixed
before the first run:

- **early**: 40% harmful, 30% neutral, 30% clearly helpful (about +7 pp each)
- **late**: 50% slightly harmful, 40% neutral, 10% slightly helpful (about +2 pp each)

Four keep rules see the same proposals:

| Rule | Keeps a commit when |
|---|---|
| naive | its score on a fixed 100-case validation set beats the best so far (autoresearch `program.md`) |
| margin | it beats the best by one standard error (the fix from autoresearch-overfit) |
| gate | Mutara `gate` promotes it: paired anytime-valid test on up to 300 fresh cases, alpha 0.05 |
| gate-loop | the same gate with alpha 0.05 / 100, split over all proposals of the run |

After the naive loop, one more `gate` compares its final champion with the starting code
on up to 1000 fresh cases. That is the **final audit**.

## Results

Mean over 100 seeds. "pp" is percentage points of the true pass rate. A false keep is a
kept proposal with true delta <= 0. Harmful means delta < -0.05 logit.

**Early regime**

| Rule | Kept | False keeps | Harmful | True gain | Worst seed | Claimed gain | Evaluations |
|---|---|---|---|---|---|---|---|
| naive | 12.5 | 1.9 | 0.6 | +43.7 pp | +24.0 | +46.4 pp | 10,100 |
| margin | 3.2 | 0.1 | 0 | +22.5 pp | -6.5 | +29.0 pp | 10,100 |
| gate | 7.3 | 0.3 | 0.1 | +40.5 pp | +13.3 | | 55,204 |
| gate-loop | 1.5 | 0 | 0 | +13.7 pp | -0.4 | | 56,472 |

**Late regime**

| Rule | Kept | False keeps | Harmful | True gain | Worst seed | Claimed gain | Evaluations |
|---|---|---|---|---|---|---|---|
| naive | 3.1 | 1.4 | 0.7 | +0.2 pp | -5.2 | +9.5 pp | 10,100 |
| margin | 0.8 | 0.3 | 0.2 | +0.2 pp | -3.2 | +7.0 pp | 10,100 |
| gate | 1.7 | 0.8 | 0.3 | +0.4 pp | -3.5 | | 57,979 |
| gate-loop | 0 | 0 | 0 | 0 pp | -0.4 | | 58,720 |

**Final audit of the naive champion**

| Regime | Promote | Reject | Inconclusive | Promoted without a true gain | True gain > 1 pp, not promoted | Evaluations |
|---|---|---|---|---|---|---|
| early | 100 | 0 | 0 | 0 | 0 | 44 |
| late | 12 | 3 | 85 | 0 | 21 | 1,833 |

## What this says

- **Gate on every step does not pay.** It cost 5.5x the evaluations of the naive loop and
  reached about the same true gain. At alpha 0.05 per proposal, false keeps still pile up
  over 100 proposals (0.8 per late run). Splitting alpha over the run removes them and
  also removes almost every real gain at 300 pairs.
- **The naive loop's main damage is the number it reports.** In the late regime it claims
  +9.5 pp on validation for a true +0.2 pp. In the early regime, with large effects, the
  naive loop does fine.
- **One final audit is where Mutara helps.** Across 200 runs it never promoted a branch
  without a true gain. With `--seeds 300` it did so once in 600 runs, inside the 5% alpha. In the late regime it turned 85 claimed improvements into
  "inconclusive" for about 18% of the loop's evaluation budget. The cost: 21 branches
  with a real gain above 1 pp went unconfirmed. Mutara does not prove a small gain cheaply.

Run history: the first version used two standard errors for `margin`, kept almost nothing,
and was switched to one, the threshold autoresearch-overfit used. `gate-loop`, the harmful
column and the final audit were added after the first run showed false keeps at alpha 0.05.
The proposal mixes did not change.

## Equal budget

The rules above get different budgets: `naive` spends 100 evaluations per proposal, `gate`
up to 600. Here every rule gets the same budget per run, `BUDGET = 100 + 100 x 100 = 10,100`
evaluations, and takes proposals until it runs out. All rules read the same pre-drawn stream
of proposal deltas (`rng(5000 + seed)`), so a rule that gets further sees the continuation
of the same stream. `naive` and `margin` take exactly 100 proposals, as before.

`seq-<cap>-<alpha>` runs the paired anytime-valid test (`gateDecision`) on fresh cases, at
most `cap` pairs per proposal, 2 evaluations per pair, charged to the budget. It keeps only
when the test accepts. Reaching `cap` undecided, or running out of budget mid-test, counts
as discard. Grid: `cap` in {25, 50, 100}, `alpha` in {0.05, 0.2}. Every rule ends with the
same final audit, 1000 fresh pairs at alpha 0.05.

This is a simulation. Proposals do not depend on feedback; a real agent learns from the
history.

**Criterion, written before the first run and not changed after:**

- Success: at least one `seq-*` configuration has a higher true gain than `naive` in both
  regimes, early and late, by more than 2 standard errors of the per-seed paired difference
  over 100 seeds. Its mean harmful keeps are not above `naive`'s, and its worst seed is not
  worse than `naive`'s worst seed.
- Confirmation: the configurations that pass are rerun on 300 new seeds, same parameters
  (`--first-seed 100 --seeds 300`, seeds 100-399). Picking the best configuration from the
  grid is itself fitting, so it has to hold on seeds it was not picked on.
- Failure: no configuration passes. Then Mutara's value in agent loops is the final audit,
  not a faster search.

### Result: no configuration passes

`node examples/autoresearch/simulate.mjs` (100 seeds, seeds 0-99), `report.equalBudget`.
Every rule spent exactly 10,100 evaluations in every run. "±" is one standard error over
seeds; "vs naive" is the per-seed paired difference. Audit is promote / reject /
inconclusive out of 100 runs.

**Early regime**

| Rule | Proposals | Kept | False keeps | Harmful | True gain, pp | vs naive, pp | Worst seed | Audit P / R / I |
|---|---|---|---|---|---|---|---|---|
| naive | 100 | 12.87 | 2.28 | 0.88 | +43.4 ± 0.5 |  | +19.2 | 100 / 0 / 0 |
| margin | 100 | 3.27 | 0.1 | 0.03 | +23.3 ± 1.1 | -20.1 ± 1.3 | -0.6 | 91 / 0 / 9 |
| seq-25-0.05 | 202.6 | 0.61 | 0.03 | 0.01 | +4.2 ± 0.6 | -39.2 ± 0.8 | -0.9 | 38 / 3 / 59 |
| seq-25-0.2 | 205.6 | 8.94 | 2.08 | 1.04 | +30.9 ± 0.9 | -12.5 ± 1.0 | -6.6 | 98 / 1 / 1 |
| seq-50-0.05 | 102.5 | 1.9 | 0.2 | 0.03 | +12.4 ± 0.9 | -31.0 ± 0.9 | -2.4 | 76 / 0 / 24 |
| seq-50-0.2 | 105.9 | 8.35 | 1.88 | 0.9 | +31.4 ± 1.0 | -12.0 ± 0.9 | +1.4 | 98 / 0 / 2 |
| seq-100-0.05 | 52.9 | 2.11 | 0.16 | 0.01 | +14.1 ± 1.0 | -29.2 ± 1.0 | -0.8 | 80 / 0 / 20 |
| seq-100-0.2 | 55.8 | 6.63 | 1.26 | 0.59 | +27.8 ± 1.2 | -15.6 ± 1.2 | -1.6 | 94 / 0 / 6 |

**Late regime**

| Rule | Proposals | Kept | False keeps | Harmful | True gain, pp | vs naive, pp | Worst seed | Audit P / R / I |
|---|---|---|---|---|---|---|---|---|
| naive | 100 | 3.11 | 1.53 | 0.68 | -0.1 ± 0.2 |  | -6.0 | 6 / 3 / 91 |
| margin | 100 | 0.73 | 0.31 | 0.13 | +0.1 ± 0.1 | +0.2 ± 0.2 | -2.4 | 4 / 2 / 94 |
| seq-25-0.05 | 202.4 | 0.21 | 0.07 | 0.02 | +0.1 ± 0.1 | +0.2 ± 0.2 | -1.5 | 0 / 4 / 96 |
| seq-25-0.2 | 205.7 | 8.48 | 5.1 | 2.94 | -3.4 ± 0.4 | -3.3 ± 0.5 | -14.5 | 4 / 35 / 61 |
| seq-50-0.05 | 101.9 | 0.75 | 0.42 | 0.15 | -0.1 ± 0.1 | -0.1 ± 0.3 | -3.4 | 2 / 4 / 94 |
| seq-50-0.2 | 105.4 | 6.61 | 4.17 | 2.2 | -2.9 ± 0.4 | -2.8 ± 0.5 | -16.1 | 5 / 26 / 69 |
| seq-100-0.05 | 51.9 | 0.64 | 0.39 | 0.17 | -0.2 ± 0.1 | -0.1 ± 0.3 | -3.7 | 2 / 7 / 91 |
| seq-100-0.2 | 54.2 | 4.01 | 2.41 | 1.23 | -1.3 ± 0.3 | -1.2 ± 0.4 | -11.5 | 5 / 15 / 80 |

`criterion.passing` is empty, so there was nothing to confirm on new seeds and the 300-seed
run was not made. `naive` here differs a little from the table above (43.4 vs 43.7 pp early)
because it reads the new shared stream.

- **Early:** every `seq-*` finds less than `naive`, by 12 to 39 pp. With cap 25 the test
  checks twice as many proposals but rarely decides within 25 pairs, so at alpha 0.05 it kept
  0.6 changes per run. Effects here are about +7 pp, and 100 validation cases resolve them
  well enough for `naive`.
- **Late:** no `seq-*` beats `naive` by more than one standard error (best: +0.2 ± 0.2 pp).
  At alpha 0.2 the test keeps 1.2 to 2.9 harmful changes per run and loses 1.3 to 3.4 pp; at
  alpha 0.05 it keeps under one change per run.
- The final audit behaves as before: it promoted a branch without a true gain in at most 1
  of 100 runs for any rule.

Conclusion: in this simulation the sequential test does not make the loop find more for the
same budget. Mutara's value in an agent loop is the final audit and catching unconfirmed
keeps, not a faster search. Per the plan, `--rule seq` in `loop.mjs` is not built.

## Real loops

[loop.mjs](loop.mjs) runs the autoresearch loop on three real tasks and ends with one
`gate`. The proposer edits one file and nothing else. The loop runs the guard and the
validation itself, so the agent cannot print its own score.

| Task | Agent edits | Validation (loop keeps on) | Fresh cases (audit) | Cost per step |
|---|---|---|---|---|
| [perf](tasks/perf/) | `topWords()` in JS, output must not change | median of 5 timings on one text | 300 texts, both versions timed in alternating order, one process per case | ~1 s, CPU |
| [lunar](tasks/lunar/) | Lunar Lander controller in Python, storm | solved share, 100 fixed seeds | 300 new seeds | ~2 s, CPU |
| [rag](tasks/rag/) | retrieval over SciFact, plain JS | nDCG@10 on 30 judged claims | 300 test claims | <1 s, CPU |

```bash
pnpm build
node examples/autoresearch/tasks/rag/fetch.mjs            # SciFact, about 3 MB, into data/
MUTARA_LLM_API_KEY=... node examples/autoresearch/loop.mjs rag runs/rag-1      # OpenRouter model proposes
node examples/autoresearch/loop.mjs perf runs/perf-aa --proposer noop               # A/A control
node examples/autoresearch/loop.mjs rag runs/rag-pos --proposer replace:$PWD/examples/autoresearch/tasks/rag/better.mjs --proposals 1
```

The default proposer sends the file and the step history to an OpenAI-compatible chat
model and writes back the file from its reply. It has no tools. Defaults: OpenRouter
(`MUTARA_LLM_BASE_URL`), `stealth/space-bunny-alpha` (`--model` or `MUTARA_LLM_MODEL`).
`--proposer claude` uses `claude -p` in `RUN/work` with `Read(./**)` and `Edit(./<file>)`
only. lunar uses
`uv` like [examples/lunar](../lunar/). `report.json` puts the claimed validation gain next
to the fresh means and the verdict.

### Controls (measured on this machine)

**A/A, perf, `noop` proposer, 20 steps, 3 runs.** Every step only adds a comment.

| Run | Kept | Claimed speedup | Fresh share of champion | Audit |
|---|---|---|---|---|
| 1 | 2 | 2.6% | 0.4999 | inconclusive, 300 cases |
| 2 | 1 | 2.6% | 0.4998 | inconclusive, 300 cases |
| 3 | 4 | 5.0% | 0.5001 | inconclusive, 300 cases |

lunar and rag are deterministic, so `noop` keeps nothing there. Their fake gains come from
fitting 100 or 30 validation cases, which only a real proposer can do.

**Positive control, `replace:` with `tasks/*/better.*`.**

| Task | Validation | Fresh | Audit |
|---|---|---|---|
| perf (Map instead of object) | 9.60 -> 8.30 ms | share 0.466 -> 0.534 | promote at 96 cases |
| lunar (constants from examples/lunar) | 0.57 -> 0.75 solved | 0.533 -> 0.770 | promote at 45 cases |
| rag (BM25) | 0.589 -> 0.741 nDCG@10 | 0.482 -> 0.669 | promote at 39 cases |

BM25 at 0.669 on the SciFact test set is close to the published BEIR figure of about 0.665,
a check that the harness scores correctly.

Bugs the controls caught: the first perf audit timed all cases in one process. Identical
code then drew shares of 0.499, 0.509 and 0.503 across three processes, a shared offset that
breaks the independence the gate assumes. One process per case, with the import order
alternating, brought it to 0.4993 and 0.5005. A 1.14x speedup also needed 96 of 100 fresh
cases, so perf now uses 300.

### Agent runs

One run per task, 20 steps, proposer `stealth/space-bunny-alpha` on OpenRouter with
reasoning effort `medium`. At the default effort the model spent all 32k tokens reasoning
and returned no code (`runs/aborted-*`), so both first runs were restarted with `--effort`.
Proposer tokens: rag 89,550, lunar 42,019, perf 74,200.

| Task | Kept / crash | Validation (claimed) | Fresh, 300 cases | Final audit |
|---|---|---|---|---|
| rag | 9 / 0 | nDCG@10 0.589 -> 0.827 | 0.482 -> 0.668 | promote at 44 cases |
| lunar | 6 / 0 | solved 0.57 -> 0.82 | 0.533 -> 0.713 | promote at 105 cases |
| perf | 7 / 4 | 9.52 -> 6.93 ms (1.37x) | share 0.394 -> 0.606 (1.54x) | promote at 32 cases |

Two more runs used `--proposer claude` (Claude Code with the user's own settings and hooks),
20 steps each:

| Task | Kept | Validation (claimed) | Fresh, 300 cases | Final audit | Cost |
|---|---|---|---|---|---|
| lunar | 9 | solved 0.57 -> 0.92 | 0.533 -> 0.933 | promote at 25 cases | $4.19 |
| perf | 4 | 9.48 -> 6.16 ms | share 0.369 -> 0.631 | promote at 26 cases | $6.17 |

The lunar run was interrupted once at step 18 and resumed from its log. No per-commit curve
was run for the Claude runs.

All three final audits say promote, and all three gains are real. The audit against the
start hides what happened after the first useful steps. [curve.mjs](curve.mjs) scores
every kept commit on the fresh cases and gates it against the previous kept commit:

| Task | Kept step | Validation | Fresh | Gate vs previous kept |
|---|---|---|---|---|
| rag | 1 (BM25) | 0.741 | 0.669 | promote |
| rag | 2, 4, 6, 8, 9, 11, 14, 16 | 0.814 -> 0.827 | 0.676 -> 0.668 | inconclusive, all 8 |
| lunar | 1 | 0.64 | 0.633 | promote |
| lunar | 2 | 0.72 | 0.667 | inconclusive |
| lunar | 4 | 0.78 | 0.757 | promote |
| lunar | 5, 10, 19 | 0.80 -> 0.82 | 0.757 -> 0.713 | inconclusive, all 3 |
| perf | 1, 2, 7, 10 | 8.51 -> 7.79 ms | share 0.529, 0.518, 0.526, 0.518 | promote, all 4 |
| perf | 11, 13, 15 | 7.33 -> 6.93 ms | share 0.499, 0.500, 0.500 | inconclusive, all 3 |

- **rag:** after BM25 in step 1, eight kept steps (stemming, stopwords, title weights)
  raised validation by 0.086 on 30 claims and changed nothing on 300 fresh ones. The final
  champion scores the same as plain BM25 (0.668 vs 0.669 for `tasks/rag/better.mjs`).
- **lunar:** the shipped champion is worse than its own step 5. A separate gate of step 5
  against the champion on the same 300 seeds: step 5 better, decided at 155 seeds; the
  champion won 2 seeds and lost 15. Validation went up by 0.02 while fresh went down by 0.044.
- **perf:** the last three kept steps claim 7.79 -> 6.93 ms, an 11% speedup, and show none
  on fresh texts. The guard caught four wrong heap implementations (crash).

In total 7 of 22 kept steps hold up against the previous kept commit. One run per task and a
free stealth model: this shows what the audit catches, not how often a given model overfits.
The curve gates reuse one fresh set for several comparisons; read them as diagnostics.

What follows for Mutara in a loop: gating only the start against the champion is not
enough. Gating each candidate that validation would keep catches these steps. Keeps were 22 of
60 steps here, and a gate cost 32-155 fresh cases when decisive and all 300 when not. That
differs from the simulated `gate` rule above, which gated every proposal. It needs a fresh
set per gate, or alpha split across the keeps. Not built yet.

### Keep rule with a real agent (rag)

The equal-budget simulation found no gain from the sequential test, but its proposals did
not learn from feedback. This run puts the rule inside a real loop. Same task (rag), same
proposer (`stealth/space-bunny-alpha`, effort medium), 20 proposals per run, 5 runs per rule:

- `naive`: keep if nDCG@10 on the 30 validation claims beats the best so far.
- `seq`: Mutara's paired anytime-valid test of candidate vs champion on a pool of 779 other
  judged train claims, seeded random order, alpha 0.05, stops when decisive. Keep only on
  accept.
- `naive-pool`: keep if the mean over all 779 pool claims beats the best so far. This
  separates the value of the test from the value of having more data.

The 300 test claims stay out of every rule and are used only for the final score. Rag
evaluation costs no LLM calls, so the budget is the 20 proposals, not evaluations.

**Criterion, written before the first run and not changed after.** Primary metric: fresh
nDCG@10 of the final champion on the 300 test claims, mean over 5 runs per rule.

- "The test finds more": `seq` beats both `naive` and `naive-pool` by more than 2 standard
  errors of the difference (independent runs, Welch).
- "Same result with more data": `seq` and `naive-pool` both beat `naive` by more than 2
  standard errors and do not differ from each other by more than 2. Then the gain comes from
  the larger pool, not from the test.
- Otherwise: no difference shown at 5 runs per rule. Reported as such, with the means.

Five runs per rule is small, and this is one task with one model. A pass would be a reason
for a larger study, not a general claim.

Not run. The experiment was stopped before the first run, after the equal-budget simulation
failed its criterion. `--rule` stays in `loop.mjs` for anyone who wants to run it.

## Use it on a real loop

Keep the loop as it is. Add the final audit from [program.md](program.md) with
[gate.config.mjs](gate.config.mjs):

```bash
BASE=<start sha> HEAD=<champion sha> EVAL_CMD=./eval.sh CASES=fresh-cases.json \
  npx teob-mutara gate examples/autoresearch/gate.config.mjs --out audit.json
```

`EVAL_CMD <sha> <case id>` prints one score in [0, 1]. Keep it and the case list out of the
files the agent edits: the score must not come from code the agent controls. Exit codes:
0 promote, 1 reject, 3 inconclusive, 2 error. The journal resumes after a crash.

Timing metrics need their own config. This one calls the baseline before the candidate,
four calls in parallel, so order and contention leak into the score. Time both commits in
one runner per case, in alternating order, with `concurrency: 1`. On this machine two
identical Node functions timed once each looked faster 60% of the time, and a median of
five with a 2% margin still kept 19% of identical changes.

The audit needs per-case scores. It fits prompt and agent evals, latency and build time
(repeated timings as cases) and sharded evaluation. It does not fit one 5-minute GPU run
that returns one number.
