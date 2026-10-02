# Connect-4 5x5 starter (component search)

Second game on the same scaffold as `../tictactoe`. No changes to `src/` or TEOB.
Proves the method transfers, not just two tic-tac-toe tricks.

* Board 5x5, win 4, gravity. X = version policy (MCTS 15 sims + component
  priors on root UCB and rollouts), O = fixed-baseline MCTS.
* Components `{takeWin, blockWin, center, edge}×{weight}×{always,early,late}`.
  (`threat`/`fork` were tried, missed, and removed — see below.)
* Case `sample` pinned: starter by parity + split rng streams. No recycling.
* `recovery: repeatable`, cost 0.
* Gate (documented host choice): gain on train and validation (64 seeds each)
  plus more validation wins than losses. 32 seeds were below the noise floor
  (`~0.06` vs threshold `0.02`) and rejected everything; 64 resolved gains
  of `+0.02..+0.05` per trial.

```bash
pnpm run build
node examples/connect4/bench.mjs c4-comp-v2 ./examples/connect4/learning.db
```

Measured once (`c4-comp-v2`, 10 rounds × 4 jobs × 64 games = 2560 games,
~15 s): 10 trials, 3 accepted, champion `{blockWin 0.5, center 1, takeWin 0.5}`,
held-out 200 games `0.745 (135W/28D/37L)` vs initial `0.53 (94W/24D/82L)`.
Single-task result on one seed set. New behavior = new ID + new DB; reruns
resume without re-executing.

## Self-play (tried, removed — record kept)

Was `selfplay.mjs` + `sp-bench.mjs` (deleted, same precedent as threat/fork):
candidate vs reigning champion, both seats, absolute 0.5 par. Measured once
(3 links × 8 rounds, ~50 s): links accepted 2/0/2. Head-to-head vs the v2
champion `0.5725`, but vs the weaker fixed baseline `0.65` vs v2's `0.715`
same-seed, vs deep MCTS `0.175` vs `0.15` (noise). Specialized against itself,
dulled against others — the pathology, caught by the guards. A league of past
champions would be the next step, not a revival of these files.

Restored on 2026-10-03 (`selfplay.mjs`, `sp-bench.mjs`, import paths only)
to compare against a league, see [../league](../league/). Across 5
replicates self-play averages `0.6825 ± 0.013` vs fixed; the `0.65` above is
replicate 0. A paired league (`league-paired.mjs`, `league-paired-bench.mjs`) did not beat it.

## Chain and ceiling

`chain.mjs`: 3 links × 6 rounds, fresh seeds per link, champion handoff.
Measured once (~30 s): links accepted 2/1/0, final held-out 200
`0.66 (108W/49D/43L)` vs original `0.54`. Plateau by link 3.

`ceiling.mjs [games]`: exact minimax is infeasible on 5x5, so the reference is
deep MCTS (500 sims, ~12 s per 100 games). Measured once: champion takes
`0.15` off deep (baseline `0.04`); deep takes `0.89` off champion. Real
headroom remains, but closing 33× search budget with priors alone is a
different project — this starter proves transfer, not optimality.

## Negative result: threat/fork features (removed)

Added `threat` and `fork` with line-based counting, budget raised to 16 rounds
(`c4-comp-v4`): same 2 accepts as the 10-round prefix, held-out `0.60` —
worse than v2's `0.745`. Bigger space at fixed-ish budget loses to focused
space; `fork` never selected, heavy `threat` alone overfits. Removed from the
registry. Re-running the focused space (`c4-comp-v5`) reproduced v2 exactly:
`0.745 (135W/28D/37L)` — determinism check passed.

## League vs self-play (experiment 2, criteria written before the run)

Hypothesis: self-play against one champion tunes the candidate to that
champion. Scoring the candidate against a league (current champion plus
frozen past champions) should reduce that, and strength against fixed
opponents should not drop.

`league.mjs` (`connect4-league-v1`), `league-bench.mjs`. Same proposer,
3 links x 8 rounds, fresh seeds per link, 64 train + 64 validation games per
round in both arms. Self-play is `sp-bench.mjs` with a seed argument, logic
unchanged.

- League in the plan, frozen per link: link 1 = [v2], link k = v2 plus the
  champions of all earlier links. `jobs` gets no history and `propose` stays
  pure, so the league cannot change inside a link.
- Opponents per round: current champion plus the league, no duplicate ids.
- Games split evenly by seed pairs (one X game, one O game) across
  opponents, remainder pairs to the current champion. 64 games per set.
- Accept if: mean edge (score minus 0.5, over all games) >= 0.03 on train
  and on validation; on validation the mean score against every opponent is
  >= 0.5 - 0.10 (non-inferiority, any miss rejects); wins > losses on
  validation.
- No Holm correction. With 10 to 20 games per opponent it rejects everything,
  the same noise floor as 32 seeds in LESSONS.
- Known property, accepted before the run: par 0.5 is exact only against the
  current champion. Against weaker past members a candidate equal to the
  champion already scores above 0.5, so it can pass the gain threshold.

5 seeds per arm, s = 0..4: plan seed 7919 + 100s + link, seed sets shifted by
100000s. s = 0 is the recorded self-play chain. Held-out 9000000..9000199.

Criterion, both needed:

1. League mean `vsFixed` >= 0.715 - 2 SE (SE across the 5 seeds).
2. League mean `vsFixed` minus self-play > 2 SE of the paired difference.

Otherwise a negative result, published the same way. Reported without a
criterion: `vsDeep100`, `vsV2`, accepted candidates per link.

### Result (measured once, 2026-10-03): fail

```bash
node examples/connect4/sp-bench.mjs runs/c4/sp-s0.db 0
node examples/connect4/league-bench.mjs runs/c4/league-s0.db 0
```

| s | Self-play `vsFixed` | `vsDeep100` | `vsV2` | accepted | League `vsFixed` | `vsDeep100` | `vsV2` | accepted |
|---|---|---|---|---|---|---|---|---|
| 0 | 0.65 | 0.175 | 0.5725 | 2/0/2 | 0.63 | 0.175 | 0.5425 | 2/1/0 |
| 1 | 0.715 | 0.15 | 0.49 | 0/0/2 | 0.715 | 0.15 | 0.49 | 0/0/2 |
| 2 | 0.6525 | 0.20 | 0.6175 | 1/0/0 | 0.7025 | 0.20 | 0.4675 | 2/0/1 |
| 3 | 0.6925 | 0.21 | 0.5175 | 1/0/0 | 0.715 | 0.15 | 0.49 | 1/0/1 |
| 4 | 0.7025 | 0.19 | 0.525 | 1/0/2 | 0.695 | 0.125 | 0.5025 | 1/0/0 |
| Mean ± SE | 0.6825 ± 0.013 | 0.185 ± 0.011 | 0.5445 ± 0.023 | | 0.6915 ± 0.016 | 0.16 ± 0.013 | 0.4985 ± 0.012 | |

1. League `vsFixed` 0.6915 >= 0.715 - 2 x 0.016 = 0.683: met.
2. League minus self-play: +0.009 ± 0.012, under 2 SE: not met.

Verdict: fail. The league is not measurably stronger than self-play against
the fixed opponent.

- Same budget: 48 executions x 64 games = 3072 games per run in both arms.
- s = 0 self-play reproduced the recorded chain exactly: 0.65
  (112W/36D/52L), `vsV2` 0.5725, `vsDeep100` 0.175.
- s = 1: both arms identical. Links 1 and 2 accepted nothing, so the
  champion stayed v2, the league was [v2] and the league arm reduced to
  self-play.
- `vsV2`: self-play 0.5445, league 0.4985. Self-play beats its starting
  point head-to-head, the league does not, and neither gains against the
  fixed opponent. The self-play head-to-head gain is the overfitting the
  hypothesis was about; the league removes it without adding strength.
- Criterion 1 is weak at this sample size: v2 itself scores 0.715, so it
  passes even with a mean drop of 0.02.
