# Lunar Lander in a storm (Gymnasium, external simulator)

First example on a third-party benchmark. `LunarLander-v3` (continuous), with
`enable_wind=True, wind_power=20, turbulence_power=1.5`. No changes to `src/`.

* Version = the 10 constants of Gymnasium's own `heuristic()` controller
  (`lander.py` is a parametric copy; the defaults are the stock values), searched
  in `[x/5, 5x]`. The stock heuristic averages ~280 without wind and breaks
  in the storm.
* `execute` shells out to Python (one process per job, batch of seeded episodes).
  Cost = episodes. Default runner:
  `uv run --with gymnasium[box2d]==1.3.0 --with numpy==2.5.3`. To use your own interpreter, set
  `LUNAR_PYTHON=/path/to/python`.
* Each generation: one log-normal perturbation of the champion (σ 0.25). Paired
  comparison on 30 training + 30 validation seeds (same seeds on both sides).
  Accept only if the mean return is higher on both splits with no more failures (return < 0).
  `caught` = a candidate that won on training and lost on validation. An
  optimizer trusting its own seeds would have promoted it.
* 30 generations, then a one-time audit on 200 new seeds. ~1 min per campaign.

```bash
node examples/lunar/train.mjs /tmp/lunar.db lunar-v6-both-s7919 7919 20
```

Measured once per seed (wind 20, audit = 200 held-out episodes, same
seeds for both sides):

| Campaign seed | Accepted / caught | Stock: return, solved, failed | Champion: return, solved, failed |
|---|---|---|---|
| 7919 | 4 / 3 | 141, 64%, 51 | 257, 95%, 2 |
| 2718 | 4 / 5 | 85, 51%, 80 | 211, 78%, 9 |
| 31415 | 2 / 2 | 114, 59%, 67 | 205, 80%, 26 |

Recovery: `kill -9` at generation 8 on seed 31415, then rerun with the same ID.
The finished trials replay from the journal and the campaign completes. Rerunning a
finished campaign takes 0.07 s and launches no Python.

Demo video (`video.py`): stock vs champion side by side, same held-out audit
seeds. It shows the first 3 seeds where stock crashes and the champion lands, so the
clip is selected by construction. The unbiased number is the audit table above.

```bash
cd examples/lunar && uv run -q --python 3.12 --with "gymnasium[box2d]==1.3.0" --with numpy==2.5.3 \
  --with "imageio[ffmpeg]" --with pillow python video.py /tmp/lunar-demo.mp4 < champion.json
```

`champion.json` = `{"champion": <report.champion>, "seeds": [3015838000..3015838199], "wind": 20, "episodes": 3}`.

## Gate vs ungated (negative result)

Same generator, same proposals; only the accept rule changes (`GATES` in
`experiment.mjs`, 5th CLI arg): `both` = Mutara gate (gain on training and
validation, no added failures); `pooled` = ungated, same 60 episodes as one mean;
`training` = ungated, 30 training episodes only. Held-out audit on 200 episodes, wind 20.
6th CLI arg `fixed` keeps one training benchmark for the whole campaign (validation
stays fresh), as when tuning on "seeds 0..29".

| Training seeds | Gate | Mean audit return (7919 / 2718 / 31415) | Promotions |
|---|---|---|---|
| fresh per generation | both | 224 (257 / 211 / 205) | 4 / 4 / 2 |
| fresh per generation | pooled | 233 (256 / 236 / 208) | 4 / 7 / 4 |
| fresh per generation | training | 218 (206 / 219 / 229) | 7 / 10 / 4 |
| fixed | both | 226 (237 / 246 / 195) | 2 / 5 / 2 |
| fixed | pooled | 228 (230 / 248 / 206) | 4 / 6 / 6 |
| fixed | training | 219 (232 / 226 / 198) | 5 / 5 / 6 |

No measurable quality gain from the gate here (3 campaigns, spread between seeds ≫
gap between gates). Its visible effect: fewer promotions for the same quality. The
10-constant heuristic, 30 generations and paired seeds leave little room to
overfit; the earlier 189→143 probe gap did not reproduce at this protocol. IDs:
`lunar-v4-<gate>-s<seed>` (fresh), `lunar-v5-fixed-<gate>-s<seed>` (fixed) —
v4 journals predate the `fixed` option and no longer replay under the current hash.

## Online planner (MPC) tuned by Mutara

Second controller, `planner.py`. At every env step it samples `samples` action
sequences of length `horizon`: one is the heuristic rolled out through the model
(warm start), the rest are that sequence plus Gaussian noise (std `noise`), clipped
to [-1, 1]. All are rolled out at once in a vectorized numpy model. The planner scores
them and executes the first action of the cheapest one, then replans. Cost
per step: `w_pos·(|x|+|y|) + w_vel·(vx²+vy²) + w_angle·|θ| + w_spin·|ω| + w_fuel·fuel`,
plus `w_crash` once if the model touches y ≤ 0 with |vy| > 0.5 or |θ| > 0.4. Once
the legs touch, the heuristic settles the lander (the model has no contact physics).
Planner noise uses `default_rng(seed)` per episode, so reruns are bit-identical
(`test_planner.py`). Mutara does not plan. It tunes the planner's parameters and gates promotions.

No oracle: the model never clones the env. It is a rigid body over
`(x, y, vx, vy, θ, ω)` in observation units with no wind. The geometry comes from the
observation normalization (Δx = vx/100, Δy = 0.0225·vy, Δθ = ω/20, horizontal
velocity units 1.5× vertical). The four gains are found by `python planner.py`,
which steps the windless env from spawn with fixed actions (none / full main /
full side), 8 seeds × 12 steps each, and takes mean velocity changes:
`gravity 0.0266` (= 10 m/s² in obs units), `main_gain 0.047`, `side_gain 0.0066`,
`torque_gain 0.040`.

Version = one flat object: the 10 heuristic constants (warm start) + `horizon`
(5..40) + `samples` (16..256) + `noise` (0.02..1) + 6 cost weights, continuous ones
in `[x/5, 5x]`, plus the model switches `fitted` (0/1) and `wind_k` (0..50). The 4
model gains are no longer searched: `fitted: 0` pins them to the hand values,
`fitted: 1` uses a least-squares fit from logged training flights, `wind_k > 0`
adds a drift estimate over the last k steps. Variants (`VARIANTS` in `train.mjs`):
`hand`, `fitted`, `wind` (switches frozen at those values) and `auto` (Mutara may flip them). The cap is `samples × horizon ≤ 2048`. Proposals: log-normal
(σ 0.25) on continuous parameters; ±1 or ±25% (rounded) on integers. Same
protocol as above: wind 20, 30+30 fresh seeds per generation, gate `both`, 30
generations, audit on the same 200 held-out seeds as the heuristic table.

```bash
# args: storage id seed wind gate seeds variant [auditWind]
node examples/lunar/train.mjs /tmp/lunar-mpc.db lunar-mpc2-hand-w20-s7919 7919 20 both fresh hand
```

The table below was measured with the earlier revision that searched the model
gains (`lunar-mpc-v1-*`); it does not replay under the current hash. Results for
the `mpc2` variants (wind 20, and selected at wind 10 / audited at 20) are not
in yet.

Measured once per campaign seed (runtime: Python 3.12.9, arm64, gymnasium 1.3.0,
numpy 2.5.3, box2d 2.3.10). Audit: return, solved (≥ 200), failed (< 0) out of 200
episodes, wall clock per episode (episodes run in lockstep batches).

| Seed | Stock heuristic | Untuned MPC | Tuned MPC (acc / caught) | Tuned heuristic (acc / caught) |
|---|---|---|---|---|
| 7919 | 141, 64%, 51 · 9 ms | 196, 78%, 25 · 44 ms | 246, 94%, 0 · 46 ms (4 / 5) | **257**, 95%, 2 · 7 ms (4 / 3) |
| 2718 | 85, 51%, 80 · 9 ms | 183, 71%, 28 · 50 ms | **247**, 94%, 2 · 56 ms (6 / 2) | 211, 78%, 9 · 12 ms (4 / 5) |
| 31415 | 114, 59%, 67 · 9 ms | 196, 74%, 23 · 46 ms | **257**, 96%, 3 · 47 ms (3 / 0) | 205, 80%, 26 · 6 ms (2 / 2) |
| mean | 113 | 192 | 250 | 224 |

1. **Planning alone** (stock heuristic → untuned MPC, same warm-start constants):
   +79 mean return and about 2.6× fewer failures, on all three seeds.
2. **Mutara tuning** (untuned → tuned MPC): +58 mean return, with failures dropping from
   25/28/23 to 0/2/3, on all three seeds.
3. **Tuned MPC vs tuned heuristic:** MPC wins on 2718 and 31415 and loses on 7919
   (246 vs 257), but has fewer failures on all three (0/2/3 vs 2/9/26). The price is
   5–7× more compute per episode, and 5–7 minutes per campaign instead of about 1.

`caught` counts every rejected candidate that won on training. The failures rule
also rejects some candidates that gained on both splits (7919 gen 18: +2.5 / +27.9).
The tuned model gains drift away from physics: on 7919 `main_gain` went
0.047→0.096 and `gravity` 0.027→0.019. That is closed-loop fitting that
compensates for the missing wind and the cost shape, not recalibration.

Known ceiling: a hand-written model with no wind knowledge; the storm is pure model
mismatch that replanning absorbs. Upgrade path: fit the model gains from logged
transitions, or add a wind-estimate term (e.g. last-k residual between predicted and
observed velocity). Three campaigns, one wind level. CEM was not tried, and whether random shooting
plateaus was not measured.

Runtime: `lander.py` reports Python/arch/gymnasium/numpy/box2d; the report
carries it and `assess` throws if the four runs of a trial disagree. Within one
runtime, reruns are bit-identical. The same campaign run in another shell gave
slightly different per-episode returns (stock audit 141.61 vs 141.37, same
champion and decisions): uv resolved numpy 1.26.4 there vs 2.5.3 here. numpy is
now pinned. Compare numbers only within one runtime. IDs: `lunar-v1-*` (no
fingerprint), `lunar-v2-*` (unpinned numpy), `lunar-v3-*` (pinned, before gate modes), `lunar-v5-*` (before `planner.py`) superseded by
`lunar-v6-both-*`, which reproduces the table above exactly under the current hash.

Honest caveats: three campaigns, one wind level, a random-search generator.
Before the ungated-optimizer comparison, a sanity probe (plain hill-climb, not in the repo)
reported 189 on its own 30 seeds and 143 on held-out. That gap between the two numbers is the
selection bias the gate exists to catch. Not yet tried: no-wind transfer, a
linear policy instead of the heuristic, CMA-ES as an external generator.

## Optuna through ask/tell, gate on the release (experiment 6)

Question: does a stronger off-the-shelf search, left ungated inside the loop, beat the hill-climb
when Mutara only journals it and gates the release? Bridge: `examples/search-bridge/ask-tell.mjs`
turns any `ask(history) -> config` searcher into an `Adapter`. `optuna_ask.py` rebuilds an Optuna
study from the journaled history on every call (`add_trial`), sampler `TPESampler(seed = campaign
seed + trials so far)`, log-uniform on the same `[x/5, 5x]` box, stock constants enqueued as trial 0.
Same history in, same candidate out, so a resumed campaign replays recorded proposals from the
journal and never calls Python for them. Runner: `uv run --python 3.12 --with optuna==5.0.0
--with numpy==2.5.3` (ask), the simulator pins from above (episodes).

Arms, equal search budget of 3600 episodes per campaign, wind 20:

* **A hill**: `train.mjs`, gate `both`, fresh seeds, IDs `lunar-x6-hill-s<seed>`.
* **B optuna-free**: `optuna.mjs`, 60 trials × 60 fresh episodes, every trial accepted, release =
  best trial by its own 60-episode mean. IDs `lunar-x6-optuna-s<seed>`.
* **C optuna-gated-release**: B's journal, plus one `gate()` of B's release vs stock on 100 fresh
  seeds (`3100000000 + seed·1000 + i`), `minimumGain 0`, `scoreRange 1000`, violation = return < 0,
  early stopping on. `promote` releases B's pick, otherwise stock. Gate episodes count outside
  the budget and are reported separately.

Audit for all arms: the 200 held-out seeds `train.mjs` uses for that campaign seed
(`3000000000 + seed·2000 + i`, so 3015838000..3015838199 for 7919), wind 20. Campaign seeds,
fixed in advance: 7919, 2718, 31415, 1618, 14142. Results in `runs/lunar-optuna/` (gitignored).

```bash
node examples/lunar/optuna.mjs runs/lunar-optuna 7919
node examples/lunar/train.mjs runs/lunar-optuna/hill.db lunar-x6-hill-s7919 7919 20 both fresh
```

Criteria, written before the first run and not changed after:

1. The bridge works: B finishes on all 5 seeds, and `kill -9` mid-campaign on one seed followed by
   a rerun with the same ID finishes it with 0 Python calls for trials already recorded.
2. Quality: mean audit return of C exceeds A by more than 2 SE of the paired (C − A) difference
   over the 5 seeds.

Both = success. Otherwise a negative result, published the same way. If 1 holds and 2 does not:
the bridge works, and a strong search on 10 constants does not beat the simple one.
Reported without affecting the verdict: B vs C (how often the gate blocked the release, and the
blocked candidate's audit vs stock), B's gap between its own estimate and the audit, gate
episodes, time per campaign.

### Results (measured once, 2026-10-03)

Runtime: Python 3.12, arm64, gymnasium 1.3.0, numpy 2.5.3, optuna 5.0.0. Audit: return, solved
(≥ 200), failed (< 0) out of 200. Hill: accepted / caught. Gate: verdict, pairs evaluated
(early stop; 2 episodes per pair).

| Seed | Stock | A hill | B optuna-free | C gated release | Gate on C | B's pick: trial, own estimate, gap to audit |
|---|---|---|---|---|---|---|
| 7919 | 141, 64%, 51 | 257, 95%, 2 (4 / 3) | 234, 90%, 5 | 234, 90%, 5 | promote, 63 | 40, 238, +4 |
| 2718 | 85, 51%, 80 | 211, 78%, 9 (4 / 5) | 240, 96%, 2 | 240, 96%, 2 | promote, 39 | 47, 237, −3 |
| 31415 | 114, 59%, 67 | 205, 80%, 26 (2 / 2) | 251, 96%, 4 | 251, 96%, 4 | promote, 43 | 27, 261, +10 |
| 1618 | 102, 57%, 70 | 237, 90%, 1 (4 / 2) | 239, 95%, 5 | 239, 95%, 5 | promote, 55 | 44, 255, +17 |
| 14142 | 111, 60%, 62 | 242, 93%, 4 (7 / 6) | 234, 91%, 5 | 234, 91%, 5 | promote, 68 | 54, 239, +5 |
| mean ± SE | 111 ± 9 | 231 ± 10 | 240 ± 3 | 240 ± 3 | 5 of 5 | gap +7 |

Verdict: criterion 1 met, criterion 2 not. The bridge works, and a strong search on 10 constants
does not beat the simple one: C − A per seed −23.6, +29.8, +46.2, +1.2, −8.2, mean +9.1, SE 12.7,
threshold 25.4. A reproduces the recorded 257 / 211 / 205 exactly; stock audits match across arms.

* Recovery: `kill -9` on 2718 after 23 recorded trials (journal seq 116, trial 22 decided), before
  trial 23's proposal was written. The rerun called `optuna_ask.py` 37 times (trials 23..59) and
  `lander.py` 37 times: 0 calls for recorded trials. Trial 23 was re-asked from the same history,
  the designed path for a crash between ask and journal write. Replaying a finished campaign: 0 calls.
  The report field `resumedFrom` is read after recovery has already advanced, so it shows 23 trials
  with a pending proposal; the journal is the source for these numbers.
* The gate never blocked: 5 of 5 promoted, so B = C. Gate episodes 126 / 78 / 86 / 110 / 136
  (mean 107), on top of the 3600 search episodes.
* B's own estimate overshot the audit by 7 on average (−3..+17), far below the 189 → 143 probe.
  60 episodes per trial and a pick among 60 trials leave little selection bias here.
* Optuna's spread across seeds is smaller (SE 3 vs 10) and failures are lower (21 vs 42 of 1000),
  but the mean gain is inside the noise. No campaign repeated a candidate (0 repeats in 300 trials).
* Time per campaign: A 51..71 s, B+C 69..76 s (2718: 22 s before the kill + 47 s after).
* `optuna_ask.py` gave identical params for the same history in a manual check, at 2 and at 12
  trials (past TPE's 10 startup trials). The bridge's determinism, duplicate guard and crash resume
  are tested in `test/ask-tell.test.ts` on a toy searcher, without Python.
