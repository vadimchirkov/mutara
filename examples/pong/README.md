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
beats reaction every rally here. Next level: predictive tracker or self-play
as the sparring partner. `progress.json` / `champion.json` are git-ignored
live artifacts, regenerated every run.

```bash
node examples/pong/measure.mjs 200
node examples/pong/serve.mjs 8901   # then open http://localhost:8901/view.html
```

Verdict so far: a game costs 0.15 ms — a training round of ~200 games costs
centiseconds with a reactive policy. MCTS per decision would multiply that by
~1000×; the design sketch is a Kuhn-style reactive policy (ball/paddle
features → action), not tree search.
