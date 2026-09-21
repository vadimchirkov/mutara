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

## Self-play (`selfplay.mjs`, `sp-bench.mjs`)

The candidate fights the reigning champion, both seats (candidate seat by
sample parity, X starts, seat-split streams). No fixed baseline, no mirror:
the absolute 0.5 line is par by symmetry. Versions and proposer are shared
with the component search; 3 links × 8 rounds, fresh seeds per link, start
from the v2 champion.

```bash
node examples/connect4/sp-bench.mjs ./examples/connect4/sp-chain.db
```

Measured once (~50 s): links accepted 2/0/2, final
`{blockWin 2, center 0.5, takeWin 0.5}`. Guards on fresh seeds, same 9M set
for the as-X comparison:

* head-to-head vs v2 champion (as X): `0.5725` — beats its teacher;
* vs fixed MCTS-15 baseline (as X): `0.65` vs v2's `0.715` on the same seeds
  (−0.065, ~2σ) — gave up edge against the weaker style;
* vs deep MCTS-500: `0.175` vs `0.15` before — no measurable change.

The documented self-play pathology, caught by the guards: tuning against
itself sharpened the anti-champion game and dulled the baseline-crushing one.
A league of past champions is the next step, not a tweak here.

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
