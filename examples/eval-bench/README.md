# Eval bench: which evaluation changes help `optimize`

[search-bench](../search-bench/) showed that evaluation noise and the
acceptance rule decided the outcome before the generator did. This bench tests
five ways to make evaluation more precise. No LLM calls, $0, a few minutes.

## Plan (written before the first run, not changed after)

**Task.** A config x has 5 float dimensions in [-5, 5], `initial` = 0. Each
case has 5 fields. Each field passes with probability
p(x) = 1 / (1 + f(x) / 10), where f = Σ (x - o)² and o is drawn per seed with
each coordinate in [-3, -1] ∪ [1, 3]. At `initial`, p is about 0.3. This mimics
an extraction task where a better config gets more fields right.

**Metric.** True p of the final champion (higher is better). Also: accepted
candidates, bad accepts (accepted, but true p lower than the champion it
replaced) and executions used.

**Base condition.** Partial credit (score = share of the 5 fields correct),
independent dice for baseline and candidate, exact scorer, `heuristic` rule,
50 rounds × 10 cases per side. Each lever below changes one thing.

| Lever | Conditions | Cost |
|---|---|---|
| L1 more cases per round | 100×5, 50×10, 25×20, 10×50 (rounds × cases) | equal: 500 cases per side |
| L2 same dice for both | independent dice vs common dice per case | equal |
| L3 stable scorer | exact; noisy judge (score + N(0, 0.2), clipped); noisy judge averaged over 3 calls; noisy judge with 3× cases (50×30) | last two cost 3× the first two |
| L4 partial credit | share of 5 fields vs 1 only if all 5 correct | equal |
| L5 rule and round size | `heuristic`, `bounded`, `sequential` × (50×10, 10×50) | equal cap; `sequential` may stop early |

Each condition runs with both generators: `random` (the built-in) and
`local` (the mutation from search-bench). 10 seeds; the same seed gives the
same optimum and case dice in every condition, so differences are paired.

**Criterion.** A condition beats another if its mean true p is higher by more
than 2 standard errors of the paired difference over 10 seeds. For each lever
we compare against the base condition, or for L3 the pairs exact vs noisy,
noisy vs averaged and averaged vs 3× cases.

Storage: `runs/eval-bench/<experiment id>.db`, experiment ID
`eval-bench-v1-<condition>-<generator>-<seed>`.

## Run

```bash
pnpm build && node examples/eval-bench/bench.mjs
```

## Results

Run on 2026-10-03, 260 runs, about 4 minutes. Raw rows:
`runs/eval-bench/results.json` (local, not committed). p = true pass rate
per field of the final champion, mean ± SE over 10 seeds; `initial` has
p = 0.303. "bad" = accepted candidates that were truly worse than the champion
they replaced. Cost = cases × scorer calls.

| condition | random: p | acc | bad | local: p | acc | bad | cost |
|---|---|---|---|---|---|---|---|
| base (50×10) | 0.537 ± 0.046 | 4.0 | 2.1 | 0.670 ± 0.066 | 21.2 | 8.1 | 1000 |
| L1 100×5 | 0.601 ± 0.038 | 8.6 | 3.9 | 0.702 ± 0.065 | 36.3 | 15.5 | 1000 |
| L1 25×20 | 0.554 ± 0.041 | 1.8 | 0.5 | 0.556 ± 0.063 | 12.3 | 4.0 | 1000 |
| L1 10×50 | 0.476 ± 0.040 | 1.2 | 0.2 | 0.451 ± 0.035 | 5.0 | 1.0 | 1000 |
| L2 common dice | 0.558 ± 0.041 | 1.4 | 0.0 | 0.899 ± 0.034 | 10.4 | 0.0 | 1000 |
| L3 noisy judge | 0.461 ± 0.067 | 7.2 | 3.8 | 0.449 ± 0.080 | 22.3 | 10.0 | 1000 |
| L3 judge × 3 calls | 0.531 ± 0.046 | 5.6 | 2.6 | 0.501 ± 0.081 | 23.1 | 10.3 | 3000 |
| L3 judge, 3× cases | 0.528 ± 0.049 | 4.4 | 2.1 | 0.542 ± 0.086 | 21.4 | 8.9 | 3000 |
| L4 all-or-nothing | 0.400 ± 0.038 | 1.4 | 0.3 | 0.370 ± 0.042 | 5.0 | 1.6 | 1000 |
| L5 bounded 50×10 | 0.303 ± 0.012 | 0 | 0 | 0.303 ± 0.012 | 0 | 0 | 1000 |
| L5 bounded 10×50 | 0.303 ± 0.012 | 0 | 0 | 0.303 ± 0.012 | 0 | 0 | 1000 |
| L5 sequential 50×10 | 0.303 ± 0.012 | 0 | 0 | 0.303 ± 0.012 | 0 | 0 | 1000 |
| L5 sequential 10×50 | 0.402 ± 0.046 | 0.3 | 0 | 0.303 ± 0.012 | 0 | 0 | 823 / 1000 |

Paired differences (Δp, mean ± SE; verdict by the 2 SE rule):

| lever | comparison | random | local |
|---|---|---|---|
| L1 | base → 100×5 | +0.064 ± 0.053, none | +0.032 ± 0.082, none |
| L1 | base → 25×20 | +0.017 ± 0.016, none | -0.114 ± 0.040, base better |
| L1 | base → 10×50 | -0.061 ± 0.043, none | -0.219 ± 0.059, base better |
| L2 | base → common dice | +0.022 ± 0.011, none | **+0.228 ± 0.065, common better** |
| L3 | exact → noisy judge | -0.076 ± 0.048, none | -0.221 ± 0.088, exact better |
| L3 | noisy → 3 calls | +0.070 ± 0.051, none | +0.052 ± 0.076, none |
| L3 | 3 calls → 3× cases | -0.003 ± 0.012, none | +0.042 ± 0.129, none |
| L4 | partial → all-or-nothing | -0.136 ± 0.042, partial better | -0.301 ± 0.082, partial better |
| L5 | heuristic → bounded / sequential (50×10) | -0.234 ± 0.049, heuristic better | -0.367 ± 0.069, heuristic better |
| L5 | heuristic → bounded (10×50) | -0.173 ± 0.047, heuristic better | -0.148 ± 0.029, heuristic better |
| L5 | heuristic → sequential (10×50) | -0.074 ± 0.027, heuristic better | -0.148 ± 0.029, heuristic better |

What helped, what did not:

- **Common dice (L2) is the largest gain.** With local mutation p went from
  0.670 to 0.899 at the same cost, and bad accepts fell from 8.1 to 0 per run.
  With random search the gain is not significant (+0.022 ± 0.011), but bad
  accepts also fell to 0.
- **Partial credit (L4) beats all-or-nothing** with both generators: +0.14 and
  +0.30 in p.
- **An exact scorer beats a noisy judge (L3)**: -0.22 for local. Paying 3× for
  3 judge calls or 3× cases did not recover a significant part of the loss in
  10 seeds; the two ways of spending 3× gave the same result.
- **More cases per round at a fixed budget (L1) hurt.** Fewer rounds means
  fewer candidates; with local mutation 25×20 and 10×50 lost 0.11 and 0.22.
  100×5 was not significantly different from 50×10. Bad accepts grow with
  fewer cases per round, but under the `heuristic` rule the extra candidates paid
  for them.
- **`bounded` and `sequential` (L5) accepted almost nothing** at 500 cases per
  side: 3 accepted candidates in 80 runs. This repeats search-bench and
  LESSONS: at this budget the strict rules belong in the final audit, not in
  the per-round choice.

This is one synthetic task: 5 dimensions, 5 fields, a smooth optimum, case
difficulty shared by both sides. Real tasks with a rugged landscape or
correlated cases can rank the levers differently.

## Real-task check: Lunar Lander (plan written before the run)

The synthetic win for shared randomness needs a real simulator. Lunar Lander
(`examples/lunar`) already gives both sides the same episode seeds and uses a
local mutation, so the check runs in reverse: `examples/lunar/pairing.mjs`
gives the candidate different seeds during selection (seed + 10⁹) and keeps
everything else from `train.mjs`: heuristic controller, wind 20, gate `both`,
30 generations × 30 training + 30 validation episodes, audit on 200 fresh
seeds shared by stock and champion. Lunar files are not edited, so old
journals still replay.

- Conditions: `paired` (current) vs `independent`. Campaign seeds 1-10.
  Experiment IDs `lunar-pairing-v1-<condition>-<seed>`, storage
  `runs/lunar-pairing/`.
- Metric: champion's mean audit return; also solved share and accepted count.
- Criterion: shared randomness helps on Lunar if paired beats independent by
  more than 2 SE of the per-seed difference over the 10 campaign seeds.

**Result (2026-10-03, 20 campaigns, about 6 minutes).** Mean ± SE over 10
campaign seeds, audit on 200 shared held-out episodes:

| condition | audit return | solved | accepted of 30 |
|---|---|---|---|
| paired | 218.5 ± 10.7 | 82.8 ± 4.2% | 4.1 ± 0.5 |
| independent | 215.0 ± 7.3 | 81.3 ± 2.5% | 3.6 ± 0.5 |

Paired - independent: +3.5 ± 15.5. No significant difference; the synthetic
result did not carry over. Likely reason, measured on the audit: per-episode
returns of stock and champion on the same seed correlate only 0.00-0.29 (one
value per campaign). Shared seeds cancel only the shared part of the noise, and
here wind and chaotic dynamics make two controllers fly different episodes even
from the same seed. In the synthetic task the dice decide every field directly,
so the correlation is high. The two-split gate `both` may also filter much of
the noise on its own. Raw rows: `runs/lunar-pairing/results.json` (local).

## Racing (plan written before the run)

Idea from F-Race / irace: stop evaluating a candidate as soon as it looks
worse, spend the saved cases on more candidates. Implemented in
`racing.mjs` through `adapter.early`, no change to `src/`.

- Task: the eval-bench task above (5 dims, 5 fields, partial credit,
  independent dice), with the exact scorer and with the noisy judge (σ 0.2).
- Methods, all with the `heuristic` final decision on the pairs observed:
  - `fixed10`: 10 pairs per candidate (the base condition);
  - `fixed5`: 5 pairs per candidate (best fixed split in L1);
  - `race`: up to 20 pairs; after at least 3 pairs, stop when
    mean paired gain + 1 SE < 0 (the candidate looks worse);
  - `race2`: as `race`, and also stop when mean - 2 SE > 0 (clear winner).
- Equal budget: 1000 case evaluations (both sides). Each run gets up to 100
  candidates; the result is the champion after the last trial that fits in
  1000. A run that does not use the whole budget keeps its final champion.
- Generators `random` and `local`, 10 seeds, IDs `racing-bench-v1-*`,
  storage `runs/racing-bench/`.
- Criterion: racing helps if `race` or `race2` beats both `fixed10` and
  `fixed5` by more than 2 SE of the paired difference, in at least one
  generator × scorer cell, and loses significantly in none.

**Result (2026-10-03, 160 runs, under a minute).** True p of the champion at
budget 1000, mean ± SE over 10 seeds; trials = candidates evaluated.

| scorer | generator | fixed10 | fixed5 | race | race2 | trials (f10 / f5 / race / race2) |
|---|---|---|---|---|---|---|
| exact | random | 0.537 ± 0.046 | 0.601 ± 0.038 | 0.604 ± 0.040 | 0.604 ± 0.040 | 50 / 100 / 96 / 97 |
| exact | local | 0.670 ± 0.066 | 0.702 ± 0.065 | 0.659 ± 0.074 | 0.839 ± 0.056 | 50 / 100 / 38 / 50 |
| judge | random | 0.461 ± 0.067 | 0.478 ± 0.071 | 0.516 ± 0.064 | 0.487 ± 0.062 | 50 / 100 / 82 / 85 |
| judge | local | 0.449 ± 0.080 | 0.408 ± 0.047 | 0.444 ± 0.041 | 0.450 ± 0.060 | 50 / 100 / 39 / 47 |

Of 16 paired comparisons, one is significant: `race2` beats `fixed10` with
exact scoring and local mutation, +0.169 ± 0.069. Against `fixed5` in the same
cell it is +0.137 ± 0.086, not significant. No racing variant lost
significantly. The criterion needs a win over both fixed splits, so racing did
not pass.

Why the gain is small here:

- With random search most candidates are clearly worse, so `race` drops them
  after 3 pairs. It then hit the 100-candidate cap with 175-205 of the 1000
  evaluations unspent. It matched `fixed5`, which already spends little per
  candidate.
- With local mutation most candidates are near-ties. `race` ran them to the
  20-pair cap and evaluated 38 candidates, fewer than `fixed10`. LESSONS
  already reported the same for the sequential gate: near-ties run to the cap.
  `race2`, which also stops clear winners, evaluated 50 and gave the one
  significant win.
- With the noisy judge nothing separated.

## What others report

Short notes from an Exa search, 2026-10-03. Only claims with sources.

- **Paired comparison and common seeds.** Miller (Anthropic, 2024, "Adding
  Error Bars to Evals", arXiv 2411.00640) recommends paired differences on
  shared questions and reports question-score correlations of 0.3-0.7 between
  frontier models. "Paired Seed Evaluation" (arXiv 2512.24145) reports
  order-of-magnitude effective sample size gains from shared seeds in learning
  simulators. Same mechanism as L2 here.
- **Resampling answers has a ceiling.** Miller: averaging K answers only removes
  within-question variance; past the point where it is small next to
  between-question variance, more K does nothing. Use next-token probabilities
  instead of sampled answers where possible (zero within-question variance).
  He advises against lowering temperature just to reduce variance.
- **Clustered cases.** Miller: clustered standard errors on popular evals can be
  over 3× the naive ones. Cases from one document or template are not
  independent.
- **Pairwise judging.** Prompt Duel Optimizer (arXiv 2510.13907) uses pairwise
  judge preferences with dueling bandits, since pointwise judge scores suffer
  calibration problems.
- **Racing.** F-Race / irace (Birattari et al. 2002; López-Ibáñez et al. 2016)
  drop candidates as soon as a paired test shows them worse and spend the saved
  runs on survivors. A 2026 hybrid of racing and successive halving matched
  full-evaluation portfolios with about 5% of the runs (Rasulo et al.).
- **Choosing the eval subset.** IPOMP (arXiv 2505.10736) and SESS (arXiv
  2601.03493) pick informative evaluation subsets for prompt optimization
  instead of random minibatches. arXiv 2604.08801 reports that on heterogeneous
  tasks a larger eval set makes system prompts look statistically identical.
- **CUPED.** Deng et al. (2013) cut variance by about 50% on Bing experiments
  using the same metric from before the experiment as a control variate.
