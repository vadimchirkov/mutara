# Colonel Blotto: league and exploiter where cycles exist

The league did not help in rock-paper-scissors (it froze), Connect-4 (no
cycle) or prompt injection (no whack-a-mole). Blotto is free to evaluate, has
strong cycles and a large strategy space. It is the kind of game AlphaStar's
league was built for. If the league and the exploiter do not help here, the
topic is closed.

## Game

- 20 soldiers on 5 fields. A field goes to whoever put more there, a tie on a
  field counts 0.5. The match goes to whoever holds more fields: +1 / 0 / -1.
- C(24,4) = 10626 pure strategies, so the best response is exact enumeration.
- A version is a mix of K = 4 distributions with equal weights, so one version
  can sit close to equilibrium.
- Proposer: replace one of the 4 distributions with a mutation of it (move 1 to
  3 soldiers from one field to another), deterministic in seed and round, as in
  `../league/rps.mjs`.
- Start of seed s: a random mix of 4 pure strategies drawn by seed (the same
  mix is reference point 3). The first draft started every arm from
  (20,0,0,0,0) x 4; the 1-seed smoke showed no neighbour can beat it (one
  moved group wins one field, the rest tie), so 0 accepts in every arm. Changed
  before any measured run.
- Exploitability = payoff of the best pure response against the mix. The game
  is symmetric, value 0. Lower is better.

## Arms (same total rounds, 400 each)

1. **last**: accept a candidate that beats the current champion. 4 links x 100.
2. **league**: mean payoff over the league above the champion's, no
   per-member rule. The league lives in the version, as in `rps.mjs`. 4 links
   x 100.
3. **league+exploiter**: as 2, plus before each link an exploiter (same
   proposer, goal: beat the frozen champion). Its find joins the league if it
   beats the champion. 20 links x (10 main + 10 exploiter rounds), as in
   `../league/exploiter.mjs`.

## Criteria, written before the first run

Fixed before any run. Not changed after. 10 seeds per arm.

1. Exploitability of the final league+exploiter champion is below last's by
   more than 2 SE of the paired difference across seeds.
2. Separately, not part of the verdict: exploitability of the league's average
   mix (union of all members' distributions, equal weights) vs the final
   champion of the same arm.
3. Reference points in the report: exploitability of the even split
   (4,4,4,4,4) and of a random mix of 4 distributions.

Item 1 met = success. Otherwise a negative result, published the same way.

```bash
node examples/blotto/bench.mjs runs/blotto/bench.db 10
```

## Results (measured once, 2026-10-03)

**Fail.** Every final champion in every arm and seed has exploitability 1, so
the paired difference last minus league+exploiter is 0.000 ± 0.000.

```bash
node examples/blotto/bench.mjs runs/blotto/bench.db 10
```

Reference points: even split (4,4,4,4,4) 1, random mix of 4 (the start of each
seed) 1.000 ± 0.000. Exploitability values for a mix of 4 move in steps of
0.25, and 1 is not a hard floor: a separate random search over 4-mixes (30
restarts x 300 steps, not part of the verdict) found 0.5. None of the 3 arms
left 1 in 400 rounds.

Columns per arm: final champion exploitability | league average mix
exploitability | accepted. "lx" = league+exploiter, "in" = exploiter finds
that joined the league (out of 20).

| seed | last | | | league | | | lx | | | in |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 1 | 0.4565 | 69 | 1 | 0.8167 | 60 | 1 | 0.7045 | 38 | 17 |
| 1 | 1 | 0.7436 | 78 | 1 | 0.8962 | 53 | 1 | 0.9398 | 36 | 18 |
| 2 | 1 | 0.4420 | 69 | 1 | 0.9593 | 43 | 1 | 0.8707 | 39 | 19 |
| 3 | 1 | 0.5167 | 75 | 1 | 0.8389 | 45 | 1 | 0.9271 | 30 | 18 |
| 4 | 1 | 0.4344 | 80 | 1 | 0.6853 | 58 | 1 | 0.7425 | 51 | 16 |
| 5 | 1 | 0.5185 | 81 | 1 | 0.8115 | 61 | 1 | 0.5766 | 45 | 17 |
| 6 | 1 | 0.7113 | 84 | 1 | 0.7888 | 58 | 1 | 0.7348 | 48 | 18 |
| 7 | 1 | 0.7599 | 76 | 1 | 0.8935 | 54 | 1 | 0.8904 | 38 | 19 |
| 8 | 1 | 0.6848 | 69 | 1 | 0.8884 | 56 | 1 | 0.7654 | 47 | 18 |
| 9 | 1 | 0.6563 | 80 | 1 | 0.8810 | 63 | 1 | 0.8051 | 42 | 17 |
| mean ± SE | 1 ± 0 | 0.592 ± 0.042 | 76.1 ± 1.7 | 1 ± 0 | 0.846 ± 0.024 | 55.1 ± 2.1 | 1 ± 0 | 0.796 ± 0.036 | 41.4 ± 2.0 | 17.7 ± 0.3 |

Item 2: the league's average mix beat its own final champion in every arm
(0.85 and 0.80 vs 1). The best average mix came from "last", 0.59: it cycled
most (76 accepts), so its history covers more of the space. The exploiter
found a counter in 17.7 of 20 links and its finds lowered the league average
from 0.85 to 0.80, paired difference 0.050 ± 0.031 (1.6 SE).

Verdict: league and exploiter did not lower the champion's exploitability in
Blotto. Topic closed.

The 1-seed x 2-link smoke runs are in `runs/blotto/smoke.db` (degenerate
start) and `runs/blotto/smoke-2.db`. They are checks, not results.

# Experiment 5: PSRO inside Mutara

Experiment 4 showed the acceptance rule does not matter when the search is
weak: every arm stayed at exploitability 1 while random search finds a 4-mix
at 0.5. In Kuhn poker the fix was a stronger candidate source (CFR in
`propose`, 0.0089). Here the same check on Blotto with PSRO (Policy-Space
Response Oracles, the method behind AlphaStar's league): the exploiter is the
exact best response, and the release is the population mix, not the latest
version. Any gain belongs to the algorithm. Mutara adds the journal, version
lineage, selection and recovery.

## Setup

- Game, `duel`, `payoff`, `pureStrategies` and `rng` from `blotto.mjs`,
  unchanged. Weighted exploitability lives in `psro.mjs`.
- Version: population of pure distributions, meta-strategy weights (rounded to
  1e-6), parent id.
- `propose`: exact best response to the champion's mix over all 10626 pure
  strategies (ties go to the first in `pureStrategies()` order; if it is
  already in the population, the best one that is not), add it, then solve
  the meta-game by regret matching on the population payoff matrix, 2000
  iterations, average strategy. Deterministic.
- Start: a population of one distribution drawn by seed.

## Arms

1. **psro**: always accept. Pure algorithm, Mutara only journals.
2. **psro-gated**: accept only if the new mix's exact exploitability is no
   worse than the champion's.

100 rounds each (one experiment), 10 seeds.

## Criteria, written before the first run

Fixed before any run. Not changed after.

1. Arm psro: mean exploitability of the final mix after 100 rounds < 0.25,
   and below 0.5 (the best random search found in experiment 4) by more than
   2 SE across seeds.
2. Not part of the verdict: psro-gated vs psro (paired difference ± SE),
   accepts in gated, support size (weights > 0.01), exploitability at rounds
   10/25/50/100.
3. Reference: experiment 4, every arm = 1.

Item 1 met = success. Otherwise a negative result, published the same way.

```bash
node examples/blotto/psro-bench.mjs runs/blotto/psro.db 10 100
```

## Results (measured once, 2026-10-03)

**Success.** Arm psro: mean exploitability after 100 rounds 0.149 ± 0.007,
below 0.25, and 0.351 below 0.5, about 50 SE. Experiment 4 ended at 1 in
every arm.

```bash
node examples/blotto/psro-bench.mjs runs/blotto/psro.db 10 100
```

Exploitability of the champion mix at rounds 10/25/50/100, support (weights
> 0.01) and accepts per seed.

| seed | psro 10 | 25 | 50 | 100 | support | acc | gated 10 | 25 | 50 | 100 | support | acc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 1.0000 | 1.0000 | 0.4550 | 0.1719 | 39 | 100 | 1.0000 | 1.0000 | 0.9997 | 0.9997 | 4 | 30 |
| 1 | 1.0000 | 0.7888 | 0.3841 | 0.1205 | 42 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1 | 16 |
| 2 | 1.0000 | 0.7564 | 0.3375 | 0.1457 | 36 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1 | 14 |
| 3 | 1.0000 | 0.7503 | 0.3959 | 0.1364 | 38 | 100 | 1.0000 | 0.9953 | 0.9953 | 0.9953 | 5 | 23 |
| 4 | 1.0000 | 0.9991 | 0.3164 | 0.1521 | 38 | 100 | 1.0000 | 0.9997 | 0.9997 | 0.9997 | 4 | 23 |
| 5 | 1.0000 | 0.9997 | 0.3421 | 0.1298 | 41 | 100 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1 | 20 |
| 6 | 1.0000 | 1.0000 | 0.3767 | 0.1943 | 33 | 100 | 1.0000 | 1.0000 | 0.9978 | 0.9978 | 7 | 31 |
| 7 | 1.0000 | 0.7392 | 0.2950 | 0.1288 | 40 | 100 | 1.0000 | 0.9998 | 0.9998 | 0.9998 | 3 | 14 |
| 8 | 1.0000 | 1.0000 | 0.3630 | 0.1535 | 38 | 100 | 1.0000 | 1.0000 | 0.9972 | 0.9972 | 7 | 31 |
| 9 | 1.0000 | 0.9999 | 0.3703 | 0.1572 | 41 | 100 | 1.0000 | 0.9999 | 0.9999 | 0.9999 | 1 | 23 |
| mean ± SE | 1 ± 0 | 0.903 ± 0.040 | 0.364 ± 0.014 | 0.149 ± 0.007 | 38.6 ± 0.8 | 100 | 1 ± 0 | 1.000 ± 0.001 | 0.999 ± 0.001 | 0.999 ± 0.001 | 3.4 ± 0.8 | 22.5 ± 2.1 |

Item 2, not part of the verdict:

- psro-gated minus psro: +0.850 ± 0.007. The gate broke PSRO. For the first
  20 to 30 rounds every new mix sits at about 1, and the exact value wobbles
  in the fourth decimal (0.9998 -> 0.9999). The first such wobble is rejected,
  and since `propose` is deterministic in the champion, every later round
  proposes the same candidate and is rejected again: population = accepts + 1
  in all 10 seeds. PSRO needs to pass through a plateau where its own metric
  does not improve; a no-regression gate per step stops it there.
- Ungated PSRO is not monotone either: seed 8 went 0.1363 -> 0.1535 in its
  last round. Gate the release, not each step.
- Support grows to 38.6 ± 0.8 distributions of 101 in the population.
- 142 to 149 ms per round at round 100 (best response over 10626 strategies
  plus 2000 regret-matching iterations, two exact exploitabilities in assess).

Verdict: PSRO inside a Mutara adapter cut Blotto exploitability from 1 to
0.149 in 100 rounds, where every acceptance rule in experiment 4 stayed at 1.

The 1-seed x 5-round smoke is in `runs/blotto/psro-smoke.db`. It is a check,
not a result.

# Experiment 6: where to put the gate in a PSRO run

Experiment 5 gated every step and froze. LESSONS says gate the release at the
end. Not tested: a gate between batches.

## Setup

PSRO here is deterministic and exploitability is exact. Until the first
rejection, a batch-gated run follows the ungated trajectory round for round.
After a rejection it rolls back to the last passed checkpoint, proposes the
same batch again and is rejected again: it is frozen. So every arm below is
computed from the per-round exploitability already journaled in
`runs/blotto/psro.db` (arm psro, 10 seeds, 100 rounds). No new search.

Arms, gate rule "no worse than the last passed checkpoint":

1. **end**: no gate during the run, release round 100.
2. **batch k**: gate every k rounds, k in 1, 2, 5, 10, 25, 50. Release the last
   passed checkpoint. k = 1 must reproduce psro-gated from experiment 5
   (0.9989 ± 0.0005), as a check of the method.
3. **best checkpoint k**: no gate during the run, release the checkpoint with
   the lowest exploitability among rounds k, 2k, ..., 100.

## Criteria, written before computing

Fixed before any number of this experiment was computed. Not changed after.

1. batch 25 vs end: paired difference of final exploitability (batch 25 minus
   end) not above 0 by more than 2 SE = a gate every 25 rounds is safe here.
   Otherwise it costs search.
2. Not part of the verdict: final exploitability for every k, the smallest k
   that does not freeze in any seed, best checkpoint vs end.

Limits, stated before: the metric is exact, so this is the gate with zero
noise. A sampled gate rejects on noise too and can only freeze more often.
A proposer with randomness would retry after a rollback instead of freezing.

```bash
node examples/blotto/psro-gates.mjs runs/blotto/psro.db 10 100
```

## Results (computed once, 2026-10-03)

**Safe at k = 25 in this run.** batch 25 minus end: 0.000 ± 0.000, no seed
froze. The method check holds: batch 1 gives 0.9989 ± 0.0005, the measured
psro-gated arm.

```bash
node examples/blotto/psro-gates.mjs runs/blotto/psro.db 10 100
```

Final exploitability per seed, round of the freeze in brackets ("-" = never
froze), and the best of all 100 rounds.

| seed | end | batch 1 | batch 2 | batch 5 | batch 10 | batch 25 | best of 100 |
|---|---|---|---|---|---|---|---|
| 0 | 0.1719 | 0.9997 (31) | 0.5500 (38) | 0.4239 (50) | 0.2571 (70) | 0.1719 (-) | 0.1549 |
| 1 | 0.1205 | 1.0000 (17) | 0.9999 (20) | 0.2741 (50) | 0.2220 (70) | 0.1205 (-) | 0.1205 |
| 2 | 0.1457 | 1.0000 (15) | 1.0000 (16) | 0.7564 (30) | 0.1740 (90) | 0.1457 (-) | 0.1457 |
| 3 | 0.1364 | 0.9953 (24) | 0.4999 (36) | 0.3350 (50) | 0.1996 (90) | 0.1364 (-) | 0.1292 |
| 4 | 0.1521 | 0.9997 (24) | 0.3009 (40) | 0.4093 (45) | 0.2212 (70) | 0.1521 (-) | 0.1442 |
| 5 | 0.1298 | 1.0000 (21) | 1.0000 (22) | 0.3860 (45) | 0.2086 (70) | 0.1298 (-) | 0.1298 |
| 6 | 0.1943 | 0.9978 (32) | 0.4794 (44) | 0.5771 (45) | 0.1943 (-) | 0.1943 (-) | 0.1506 |
| 7 | 0.1288 | 0.9998 (15) | 0.8457 (18) | 0.2181 (65) | 0.2181 (70) | 0.1288 (-) | 0.1243 |
| 8 | 0.1535 | 0.9972 (32) | 0.4926 (44) | 0.2288 (65) | 0.2288 (70) | 0.1535 (-) | 0.1359 |
| 9 | 0.1572 | 0.9999 (24) | 0.9986 (32) | 0.2358 (65) | 0.2358 (70) | 0.1572 (-) | 0.1409 |
| mean ± SE | 0.149 ± 0.007 | 0.999 ± 0.001 | 0.717 ± 0.088 | 0.385 ± 0.054 | 0.216 ± 0.007 | 0.149 ± 0.007 | 0.138 ± 0.004 |
| frozen | | 10 of 10 | 10 of 10 | 10 of 10 | 9 of 10 | 0 of 10 | |

Item 2, not part of the verdict:

- The cost of a gate falls with the gap between gates and reaches 0 only at
  k = 25. batch 50 = end too. Smallest k without a freeze in any seed: 25.
- batch 10 froze late, at rounds 70 and 90, well past the plateau: PSRO's
  exploitability still rises over some 10-round windows near 0.2. A gate that
  is safe early can still freeze late.
- Best checkpoint: for k >= 10 the last checkpoint was always the best one, so
  best checkpoint = end. Best of all 100 rounds beats end by 0.011 ± 0.004.
  That number picks the minimum of 100 exact values; with a sampled metric the
  minimum would carry selection bias and need a fresh check.

Verdict: a "no worse" gate every 25 rounds cost nothing here; every 10 rounds
or more often it froze the search. The zero-noise limit above applies: a
sampled gate would only freeze more.
