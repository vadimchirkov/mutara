# Strategy ideas: the full vocabulary

Every trick tried across the game starters, with measured status. For humans
designing dictionaries and machines inventing them (see
`tictactoe/auto-features.mjs` protocol). Status is per-game: an idea that wins
in one game can miss in another.

Legend: ✅ measured gain · ❌ tried, rejected · ❓ never tried here.

## Universal (any perfect-information game)

| Idea | Status | Note |
|---|---|---|
| Take the win (`takeWin`, `completesWin`) | ✅ ttt, c4 | Highest-leverage atom everywhere; selection finds it first |
| Block the immediate loss (`blockWin`, `stopsWin`) | ✅ ttt, c4 | Second pick; `stopsWin` rejected once on train (noise/domain) |
| Hold the center (`center`, `freeCenter`) | ✅ ttt, c4 | Strongest positional prior; `freeCenter` train-positive, validation-negative — caught |
| Create two threats (`fork`) | ❌ c4, ❌ ttt-machine | Train-negative alone in both games; needs a win feature beside it |
| Create one threat (`threat`) | ❌ c4, ❌ ttt-machine | Overfits alone (train +0.06, validation −0.19 in c4) |
| Corners / edges as such | ✅ ttt-human | Weak alone, useful as support |
| Opposite corner | ❌ ttt-machine | Train-positive, validation-negative — textbook trap, gate caught it |
| Spoil opponent's beginnings (`spoil`) | ❌ ttt-machine | Too broad, dilutes |
| Stay mobile (`attackCount`, open lines) | ❌ ttt-machine | Never selected |
| Squeeze opponent (`squeeze`) | ❌ ttt-machine | Never selected |
| Take space early, cash in late (`early`/`late` conditions) | ❓ | Conditions exist in every space, no measured win attributed yet |

## Chance games (Pig)

| Idea | Status | Note |
|---|---|---|
| Bank the win (`takeWin` at target reach) | ✅ | Selected |
| Cap the bust risk (`avoidBust`, hold at N) | ✅ | Round-robin says hold-at-11 is the best fixed rule for race-to-20 |
| Press small totals (`pressLuck`) | ✅ | Selected at low weight |
| Chase when behind / protect when ahead | ✅/❌ | `chase` selected, `protect` never picked up |
| Fixed threshold policy | ✅ | The ceiling itself: simple, strong, beaten only by search+priors |

## Hidden information (Kuhn)

| Idea | Status | Note |
|---|---|---|
| Play honest (value only, never bluff) | ✅ baseline | Exploitability 1/6; every search here starts from honest |
| Bluff the weak hand | ❌ greedy, ✅ CFR | Unprofitable vs non-folders — greedy search can never discover it; equilibrium finds α≈0.2 |
| Catch bluffs (call light) | ❌ greedy, ✅ CFR | Same coordination problem; Nash calls Q ~0.55 facing a bet |
| Exploit a fixed range (fold Q into K-only) | ❌ gate | Wins on train, TRICKY punishes — validation exists for this |
| Solve, don't climb | ✅ CFR | Exploitability 0.167 → 0.009 through the same engine contract |

## Meta-lessons (about invention itself)

- Surgical atoms beat broad ones; selection weights, it does not sharpen.
- Screening singles first, then combining, beats throwing everything in at once.
- A feature that wins on train and loses on validation is the norm, not the
  exception — the gate earns its keep on every run.
- The bounded (Hoeffding) bound is vacuous below thousands of games; at our
  budgets the held-out is the verdict, the gate is the filter.
- Generator-in-the-loop converges (−0.1375 → −0.04) but each look at the
  held-out spends discipline; pre-register bets, cap the rounds.
