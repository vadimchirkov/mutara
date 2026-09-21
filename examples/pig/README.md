# Pig starter (decisions under chance)

Third game on the same scaffold as `../tictactoe`. No changes to `src/` or TEOB.
Tests a new dimension the first two games lack: chance nodes.

* Race to 20. X = version policy (MCTS 15 sims + component priors over
  `{roll, hold}`), O = fixed hold-at-7. Dice sampled inside MCTS and rollouts.
* Components `{takeWin, avoidBust, pressLuck, chase, protect}×{weight}×{always,early,late}`
  (`early` = banked total below 12).
* Case `sample` pinned: starter by parity + split decision/dice rng streams, so
  a candidate burning more decision randomness does not shift the dice.
* No draws in Pig: every game ends with a winner, so all deltas are ±1.
* `recovery: repeatable`, cost 0.
* Gate (documented host choice): gain on train and validation (48 seeds each)
  plus more validation wins than losses.

```bash
pnpm run build
node examples/pig/bench.mjs pig-comp-v1 ./examples/pig/learning.db
```

Measured once (`pig-comp-v1`, 10 rounds × 4 jobs × 48 games = 1920 games,
~1 s): 10 trials, 2 accepted, champion
`{chase 0.25, pressLuck 0.25, takeWin 0.5}`, held-out 200 games
`0.755 (151W/49L)` vs initial `0.47 (94W/106L)`.
Single-task result on one seed set. New behavior = new ID + new DB; reruns
resume without re-executing.

## Ceiling (`ceiling.mjs`)

No exact DP: the reference is the best fixed hold-at-K threshold from a
round-robin (K = 4..12, 200 games per pairing, both sides). Measured once:
hold-at-11 wins the table, but the champion beats it on both sides —
`0.63` as X, `0.61` as O. Learned search + priors beats the best simple rule.
