# Pong starter (step zero: physics cost + viewer)

Can the system learn a complex game? Before wiring Mutara, measure the price
of a game. No learning here yet — just physics and a screen.

* Physics (`game.mjs`): pure, deterministic, seeded serves, no assets.
  Court 100×60, first to 5, frame skip 4 (policy decides every 4th frame).
* Measured (`measure.mjs`, 200 heuristic-vs-heuristic games): ~41M physics
  steps/sec, ~0.15 ms per game, ~1600 decisions per game, mirror match ~50/50
  across seed bases (88/106/105 — no side bias).
* Watch (`view.html` + `serve.mjs`): canvas demo with pause/speed/restart.
  Open directly for the demo; serve the directory for the live learning curve
  (`progress.json`, written by the future trainer, polled every second).

## Training (`strategy.mjs`, `experiment.mjs`, `trainer.mjs`)

Reactive policy, no tree search: weighted components vote for
{up, stay, down} every 4th frame. X learns, O is the fixed deadband tracker.
6 features (`trackBall`, `retreatCenter`, `intercept`, `holdStill`,
`avoidWall`, `attackAngle`) × weights × when. No MCTS params — the version is
components only. Gate: train/validation edge over the mirror plus wins>losses.

```bash
node examples/pong/trainer.mjs ./examples/pong/learning.db
```

The trainer runs 12 links × 4 rounds and rewrites `progress.json`
(curve) + `champion.json` (the screen plays the current champion itself)
after every link. Measured once (~25 s): statue (0.000) → link 2
`{intercept, trackBall}` (0.375) → link 3 adds `retreatCenter` (1.000) →
plateau. Held-out 200 games vs the tracker: **200/200**.

Honest caveat: the tracker is weak (no prediction, 1.5 deadband) — the
champion learned to be a perfect tracker, not a perfect player. Prediction
beats reaction every rally here. `progress.json` / `champion.json` are
git-ignored live artifacts, regenerated every run.

## Stronger sparring (`PREDICTIVE`, plan `baseline`)

v2 retires the v1 journals (strategy.mjs entered the implementation hash):
same protocol, O is a fixed all-1s predictive tracker via mirrored state
(`mirrorState` — Pong is left-right symmetric, actions map as-is). Measured
head-to-head first: v1 champion takes `0.77` off predictive (not 1.00) —
real headroom. Trainer: `node examples/pong/trainer.mjs DB predictive`
(new `pong-v2-l*` IDs, start from the rebuilt v1 champion).

Measured once (~80 s): 12 links, 1 accepted (`attackAngle`, link 2), plateau
at probe `0.938`. Held-out 200: vs predictive `0.970 (189W/10D/1L)` (v1:
`0.77`), vs deadband `200/200`, head-to-head vs v1 `0.50` both seats.
v2 dominates v1 against the field and ties it directly — no cycle pathology
this time. The screen now plays champion-vs-predictive (both predictive when
idle).

```bash
node examples/pong/measure.mjs 200
node examples/pong/serve.mjs 8901   # then open http://localhost:8901/view.html
```

Verdict so far: a game costs 0.15 ms — a training round of ~200 games costs
centiseconds with a reactive policy. MCTS per decision would multiply that by
~1000×; the design sketch is a Kuhn-style reactive policy (ball/paddle
features → action), not tree search.
