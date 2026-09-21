# Tic-tac-toe starter (MCTS tuning)

Wiring demo on top of the public optimizer. No changes to `src/` or TEOB.
Proves plumbing, not strength.

* X = tuned MCTS `{ uctC, simulations }`, O = fixed-baseline MCTS (same initial).
  v1 used a random opponent that every candidate beat ~0.9 — noise-only signal.
* Case `sample` is pinned: starter by parity + two independent rng streams
  (MCTS rollouts vs opponent draws), so a candidate burning more randomness does
  not shift the opponent's dice. Fresh indices every round, shared by baseline
  and candidate. No modulo recycling.
* `recovery: repeatable` — pure local sim, cost 0.
* `decision: heuristic` — selection only; the final word is the held-out
  W/D/L report. For a claim switch to `bounded` with
  `bounds: { min: 0, max: 1 }`, `samplesPerTrial >= 12` minimum and fresh cases
  per trial (penalty at 8 samples still exceeds most realistic gains).

Run (new ID per experiment, keep old DBs):

```bash
pnpm run build
node examples/tictactoe/run.mjs ttt-mcts-v3 ./examples/tictactoe/learning.db
```

Shared logic (`playGame`, `execute`, `space`) lives in `tuning.mjs` so the
smoke test can import it; `run.mjs` is a thin CLI wrapper. The move changed
the implementation hash, hence the new experiment ID.

The script then scores champion vs initial on 200 fresh seeds (`1_000_000+i`)
with W/D/L breakdown. Those games did not select the winner.

Longer training = supervisor chain outside the engine, not an infinite entity
(`chain.mjs`): each link is a new experiment ID with fresh train/validation
seeds, the link champion becomes the next link's `initial`, finished links
resume from journal. Measured once (3 links × 6 rounds, ~1 s): link 1 accepted
3, links 2–3 accepted 0 (plateau — converged, not forced), final held-out 200
`0.86` vs original `0.49`.

```bash
node examples/tictactoe/chain.mjs ./examples/tictactoe/chain.db
```

## Ceiling (`ceiling.mjs`)

Perfect minimax vs champion, 200 games, no journal:

* perfect vs perfect: 200 draws (sanity — minimax is correct);
* champion vs perfect: 193 draws, 7 losses;
* baseline vs perfect: 50 draws, 150 losses.

The champion is essentially at the game's ceiling; further training here is
pointless. Headroom lives in harder games (see `../connect4`).

Next step for move generation: custom `Adapter.propose` (sync, deterministic
of champion/history/seed, `parentId = champion.id`) mutating a component list
like `examples/alchemy/src/learning/strategy.ts:97`. Async/LLM generation must
be precomputed into `plan/artifact`, never hidden inside `propose`.

## Component search (structural learning)

`strategy.mjs` + `experiment.mjs` + `bench.mjs`: variable-length components
`{feature: takeWin|blockWin|center|corner|edge, weight, when}` that bias root
UCB priors and rollout policy. Fixed dims can't express this, so a custom
`Adapter` is warranted (optimizer would not cover it).

Gate for this draw-heavy domain (documented host choice, not a statistical
guarantee): gain on train and validation plus more validation wins than
losses. Alchemy's `wins > half` can never fire here — most deltas are exact 0.

```bash
node examples/tictactoe/bench.mjs ttt-comp-v5 ./examples/tictactoe/components.db
```

Measured once (`ttt-comp-v5`, 12 rounds × 4 jobs × 48 games = 2304 games):
12 trials, 4 accepted, champion `{center 2, takeWin 0.5}` held-out 200 games
`0.83 (148W/37D/15L)` vs initial `0.47 (84W/21D/95L)`. Single-task result on
one seed set; rejections included a train-negative and a train-only gain.
New behavior = new ID + new DB; `bench.mjs` resumes a finished ID without
re-executing via `startOrResume`.

## Machine dictionary (`auto-features.mjs`, `quarantine.mjs`, `auto.mjs`)

Can the machine invent the vocabulary, not just weigh it? Protocol: the
generator wrote 14 features in ONE shot, deliberately excluding the human five
— the test is invention beyond them. `quarantine.mjs` ran once offline
(2999 cases: determinism, binary output, no throws): 14/14 PASS, dictionary
pinned unrevised. Selection then ran with methodology parity: same opponent,
same 48 seeds, same heuristic gate, same capacity (5 components). Staged
proposer: rounds 0..13 screen one feature each, then free mutations.

```bash
node examples/tictactoe/quarantine.mjs
node examples/tictactoe/auto-bench.mjs ttt-auto-v1 ./examples/tictactoe/auto.db
```

Measured once (26 rounds × 4 jobs × 48 games, ~2 s): 26 trials, 3 accepted,
champion `{twoInRow 0.5, safeMove 0.5, centerVsCorner 0.5}`. Screening rejected
`fork`/`threat` alone (train-negative without a win feature) and
`oppositeCorner` (train-positive, validation-negative — correctly caught).
Held-out reuses the human run's 200 seeds (valid — held-out never selects;
paired by construction): machine `0.695 (107W/64D/29L)` vs human
`0.8325 (148W/37D/15L)`, paired mean `−0.1375`.

Verdict: invention works (0.47 → 0.70 from a cold start, win-seeking
re-emerged via `twoInRow`, safety via `safeMove`) but does not match human
knowledge. The bounded lower bound is reported in every trial reason and is
honestly vacuous at n=48 (Hoeffding penalty ~0.5 dwarfs gains) — the verdict
comes from the held-out, not the gate.
