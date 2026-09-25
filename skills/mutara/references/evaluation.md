# Establish an improvement

Choose the metric before searching: correct answers, task completion, relevant
retrieval, valid structured output, or another task-specific measure. Add cost,
latency and unacceptable failure constraints where they affect the host's objective.
If a judge is an LLM, pin its prompt/model/settings, record responses and calibrate
it against labeled cases. A candidate's own self-rating is not independent evidence.

Keep three purposes distinct:

- Development cases guide candidate construction.
- Validation cases control promotion during search.
- Final held-out cases measure the selected champion and do not enter proposal
  history, adapter plans or feedback used for tuning.

Compare baseline and candidate on paired cases under the same budgets and frozen
memory. Seeds alone do not make a remote model deterministic: record responses,
usage, model version and retries. Repeatedly tuning on the same small validation
set can overfit. Reusing it is a heuristic, not an independent statistical test.

## Acceptance options

The declarative optimizer supplies three rules: `bounded` (default),
`sequential` (anytime-valid, stops early) and explicit `heuristic`. Its weighted objective combines raw metric differences, without
normalization or hard constraints. Configure units/weights before evaluation;
use a custom adapter for mandatory quality gates. See [optimizer.md](optimizer.md)
for case indices, metric bounds and the comparison budget.

The host's `assess` decides promotion. A small deterministic test may use a simple
minimum paired gain plus hard constraints. Document that choice rather than
calling it statistically significant. Require correctness gates before optimizing
secondary metrics such as token cost.

`boundedDecision(differences, { minimumGain, range, alpha, comparisons })` is an
optional fixed-sample, one-sided Hoeffding bound with a Bonferroni allocation:

```
lower = mean(differences) - range * sqrt(log(comparisons / alpha) / (2 * n))
accepted = lower > minimumGain
```

Each finite difference must be within `[-range/2, range/2]`; for accuracy differences
in `[-1, 1]`, use `range: 2`. Cases must be independent. Predeclare the number of
comparisons. Adaptively generated candidates need fresh independent evaluation
cases; Bonferroni alone does not repair adaptive reuse of the same dataset.

`sequentialDecision` takes the same arguments and data caveats. It bets on the
differences in order (Waudby-Smith & Ramdas) and accepts once wealth reaches
`comparisons / alpha`, which stays valid when you stop as soon as it returns
`final: true`. A host adapter can stop early through `Adapter.early`.
This bound can be conservative and reject plausible gains on small datasets.

## Evidence to retain

Keep the baseline, candidate versions, cases/seeds, outputs, grades, decisions,
cost and separate final results. Use the same evaluation runner for the fixed
baseline and champion. Where practical compare against random search with the
same budget; a useful strategy does not automatically prove a better search method.

A smoke example proves wiring. A journal proves what was recorded. Improvement
requires a measured gain on cases not used to select the winner. Report uncertainty
and regressions rather than discarding unfavorable runs.

The Alchemy example previously measured 74.54 versus 63.90 known elements with a
fixed strategy and memory. That result is specific to its recipe table and search
protocol; it is not a promise of gains for a host application.
