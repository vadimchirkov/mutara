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
