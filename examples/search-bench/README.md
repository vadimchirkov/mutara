# Search bench: local mutation vs random search in `optimize`

`optimize` proposes each candidate with `randomPropose`: a fresh uniform
sample of the whole space every round. The champion only becomes the
`parentId`. This bench asks whether a local mutation around the champion finds
better configs at the same budget. Everything runs on synthetic functions, so
it costs $0 and takes minutes.

## Protocol (written before the first run, not changed after)

**Generators**, same rounds, same cases, same acceptance rule:

- A: `randomPropose`, the current default.
- B: local mutation of the champion. Pick 1 or 2 dimensions (50/50). Float:
  Gaussian step with σ = 0.1 of the range, clipped to bounds. Int: ±1, clipped.
  Enum: switch to another value with p = 0.5. Deterministic per (seed, round).
  Implemented here as `adapter.propose`, since `optimize` has no generator option.

**Functions**, each in 2, 5 and 10 dimensions, x ∈ [-5, 5]^d, `initial` = 0:

- shifted quadratic, f = Σ z²
- Rosenbrock, f = Σ 100(z₍ᵢ₊₁₎ - zᵢ²)² + (1 - zᵢ)², optimum where z = 1
- Rastrigin, f = 10d + Σ (z² - 10 cos 2πz)

z = x - o. The optimum o is drawn per seed, each coordinate uniform in
[-3, -1] ∪ [1, 3], so it is never at the center or at `initial`. A and B see
the same o for the same seed.

**Score** of one case = q(x) + N(0, σ), clipped to [0, 1], with
q = 1 / (1 + ln(1 + f)). q is 1 at the optimum and decreasing in f. Noise is
deterministic per (seed, case index, config). σ levels: 0.01 (small) and 0.1
(comparable to or above a typical per-round gain in q; halving f from 100 to 50
moves q by 0.025).

**Budget**: 50 rounds, 10 cases per side per round (1000 executions per run).
10 seeds per cell. 3 functions × 3 dims × 2 σ = 18 cells per rule.

**Acceptance rules**:

- Primary: `{ mode: "heuristic" }` (accept if mean paired gain > 0).
- Secondary: the default `{ mode: "bounded" }`. LESSONS.md already reports the
  Hoeffding bound as vacuous below thousands of samples, so we expect it to
  accept almost nothing for either generator. Reported, not used for the verdict.

**Metric**: true f of the final champion, no noise. Also the number of
accepted candidates.

**Criterion** (primary rule only):

- B wins a cell if mean f(B) < mean f(A) by more than 2 standard errors of the
  paired difference over the 10 seeds. B loses a cell if the reverse holds.
- The hypothesis holds if, at each σ level, B wins at least 4 of the 6 cells
  with d = 5 or 10, and B loses no cell anywhere (any d, any σ).
  Otherwise the result is negative and gets published as such.

Storage: `runs/search-bench/<experiment id>.db`, one database per run,
experiment ID `search-bench-v1-<rule>-<fn>-d<d>-s<σ>-<gen>-<seed>`.

## Run

```bash
pnpm build && node examples/search-bench/bench.mjs
```

## Results

Run on 2026-10-03, 720 runs, about 4 minutes. Raw rows:
`runs/search-bench/results.json` (local, not committed). Values: true f of the
final champion, mean ± SE over 10 seeds. Δ = B - A, paired by seed; negative
favors B. "acc" is the mean number of accepted candidates out of 50.

**Primary rule, `heuristic`**

| f | d | σ | A random | B local | Δ | acc A | acc B | verdict |
|---|---|---|---|---|---|---|---|---|
| quadratic | 2 | 0.01 | 0.319 ± 0.062 | 0.0458 ± 0.015 | -0.273 ± 0.066 | 2.7 | 8.3 | B wins |
| quadratic | 5 | 0.01 | 8.73 ± 1.5 | 1.10 ± 0.37 | -7.62 ± 1.5 | 1.5 | 16.4 | B wins |
| quadratic | 10 | 0.01 | 36.3 ± 3.1 | 11.9 ± 2.6 | -24.4 ± 2.6 | 0.8 | 20.8 | B wins |
| rosenbrock | 2 | 0.01 | 7.25 ± 1.6 | 2.39 ± 0.98 | -4.85 ± 2.2 | 2.9 | 6.3 | B wins |
| rosenbrock | 5 | 0.01 | 3.41e3 ± 1.1e3 | 4.17e3 ± 3.8e3 | 765 ± 4.3e3 | 2.6 | 18.3 | tie |
| rosenbrock | 10 | 0.01 | 5.62e4 ± 2.3e4 | 2.47e4 ± 1.0e4 | -3.15e4 ± 2.7e4 | 2.9 | 19.9 | tie |
| rastrigin | 2 | 0.01 | 8.04 ± 1.5 | 5.32 ± 1.1 | -2.72 ± 2.1 | 3.3 | 5.8 | tie |
| rastrigin | 5 | 0.01 | 42.1 ± 2.2 | 23.4 ± 3.4 | -18.7 ± 4.1 | 3.0 | 10.7 | B wins |
| rastrigin | 10 | 0.01 | 132 ± 9.7 | 92.5 ± 9.9 | -39.0 ± 13 | 3.7 | 18.1 | B wins |
| quadratic | 2 | 0.1 | 0.319 ± 0.062 | 8.16 ± 7.4 | 7.84 ± 7.4 | 2.9 | 17.0 | tie |
| quadratic | 5 | 0.1 | 19.2 ± 6.0 | 31.8 ± 8.2 | 12.6 ± 13 | 9.2 | 22.9 | tie |
| quadratic | 10 | 0.1 | 103 ± 13 | 70.3 ± 9.7 | -32.7 ± 18 | 17.6 | 26.2 | tie |
| rosenbrock | 2 | 0.1 | 7.66 ± 1.7 | 1.47e3 ± 1.5e3 | 1.47e3 ± 1.5e3 | 4.3 | 13.5 | tie |
| rosenbrock | 5 | 0.1 | 9.80e4 ± 2.9e4 | 9.18e4 ± 3.6e4 | -6.14e3 ± 5.2e4 | 22.8 | 24.9 | tie |
| rosenbrock | 10 | 0.1 | 2.87e5 ± 5.2e4 | 1.26e5 ± 3.2e4 | -1.60e5 ± 6.2e4 | 25.1 | 25.5 | B wins |
| rastrigin | 2 | 0.1 | 9.86 ± 2.7 | 20.0 ± 7.6 | 10.1 ± 8.7 | 11.7 | 15.6 | tie |
| rastrigin | 5 | 0.1 | 102 ± 8.3 | 83.4 ± 11 | -18.3 ± 17 | 24.6 | 23.8 | tie |
| rastrigin | 10 | 0.1 | 210 ± 17 | 184 ± 15 | -26.5 ± 26 | 24.6 | 24.9 | tie |

**Secondary rule, default `bounded`**: 0 accepted candidates in all 360 runs.
Every champion is `initial`, so A and B tie in all 18 cells.

**Verdict.** B wins 4 of 6 d = 5/10 cells at σ = 0.01 and 1 of 6 at σ = 0.1,
with no losses. The criterion needs 4 of 6 at both levels, so the hypothesis
does not hold. `randomPropose` stays the only built-in generator.

What the numbers show:

- With low noise, local mutation reached lower f on quadratic and Rastrigin at
  d = 5 and 10. It also won at d = 2 on quadratic and Rosenbrock, which the
  hypothesis did not predict.
- At σ = 0.1 and d = 5/10 the `heuristic` rule accepted 9-26 of 50 candidates
  for both generators, many on noise, and the champion drifted. At d = 2, B had
  lower f than A on 8, 5 and 3 of 10 seeds (quadratic, Rosenbrock, Rastrigin);
  single seeds that drifted far (quadratic 74.5, Rosenbrock 14600) set the mean.
- Rosenbrock d = 5 and 10 had seed-to-seed spread larger than the mean
  difference at σ = 0.01.
- Under the default rule the generator does not matter: nothing passes the
  Hoeffding bound at 10 cases per side.

Local mutation stays available as `localPropose` in `bench.mjs`; plug it in
through `adapter.propose`.
