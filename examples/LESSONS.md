# Lessons from the game starters

The game examples were removed to keep the repo focused. Each ran on the public
engine with no changes to `src/`. Their code and full READMEs, with the raw
numbers behind every claim below, live in git history:

| Game | Last version | Added in |
|---|---|---|
| Tic-tac-toe | [examples/tictactoe](https://github.com/vadimchirkov/mutara/tree/3c97b9f/examples/tictactoe) | [b92a930](https://github.com/vadimchirkov/mutara/commit/b92a930) |
| Connect-4 5×5 | [examples/connect4](https://github.com/vadimchirkov/mutara/tree/3c97b9f/examples/connect4) | [b92a930](https://github.com/vadimchirkov/mutara/commit/b92a930) |
| Pig | [examples/pig](https://github.com/vadimchirkov/mutara/tree/3c97b9f/examples/pig) | [bfeea1a](https://github.com/vadimchirkov/mutara/commit/bfeea1a) |
| Kuhn poker | [examples/kuhn](https://github.com/vadimchirkov/mutara/tree/3c97b9f/examples/kuhn) | [e4e4d75](https://github.com/vadimchirkov/mutara/commit/e4e4d75) |
| Pong | [examples/pong](https://github.com/vadimchirkov/mutara/tree/3c97b9f/examples/pong) | [e57e0ae](https://github.com/vadimchirkov/mutara/commit/e57e0ae) |

The per-game idea table (every feature tried, with status) is
[STRATEGIES.md](https://github.com/vadimchirkov/mutara/blob/3c97b9f/examples/STRATEGIES.md).
Restore any of them with `git checkout 3c97b9f -- examples/<name>`.

What they taught about the engine itself:

## Evaluation design

- **The opponent sets the signal.** Against a random opponent every candidate
  won ~0.9, so there was only noise to select on. Pong's champion beat a weak
  tracker 200/200 by becoming a perfect tracker, not a good player; a stronger
  predictive opponent revealed real headroom (0.77 → 0.97).
- **Pin cases, split randomness.** Separate RNG streams for the candidate's own
  randomness and the environment, so a candidate that draws more random
  numbers does not change the opponent's dice. Fresh case indices every round,
  shared by baseline and candidate (paired), no recycling.
- **Size samples to the effect.** In Connect-4, 32 cases per side had a noise
  floor of ~0.06 and rejected everything; 64 resolved real gains of +0.02..+0.05.
- **Pick the gate for the domain.** In draw-heavy games most paired deltas are
  exactly 0, so "wins > half" can never fire. Used instead: gain on train and
  validation plus more wins than losses on validation.
- **Sequential gate saves little on near-ties.** The anytime-valid gate stopped
  a clear winner at 134 pairs and a clear loser at 69, but 13 of 15 near-ties
  ran to the cap (5606 of 6000 games).
- **The Hoeffding bound is vacuous below thousands of samples** (penalty ~0.5
  at n=48). At these budgets the held-out set gives the verdict and the gate
  only filters.
- **Compare against the ceiling, not just the start.** Tic-tac-toe's champion
  drew 193/200 against perfect minimax, so further training was pointless. Pig's
  champion beat the best fixed hold-at-K rule on both seats (0.63 / 0.61).

## Search

- **Train-positive, validation-negative is the norm, not the exception.**
  The gate caught such features on almost every run.
- **Focused space beats a big one at a fixed budget.** Adding `threat`/`fork`
  to Connect-4 dropped held-out from 0.745 to 0.60. Rerunning the focused
  space reproduced 0.745 exactly (determinism check).
- **Screen single components first, then combine.** Narrow components beat
  broad ones: selection sets weights, it does not sharpen a vague feature.
- **Long training = a chain of experiments.** Each link gets a new ID and fresh
  seeds, and the link champion becomes the next initial. Plateau shows up as
  links that accept nothing (ttt: 3/0/0, c4: 2/1/0), which means converged,
  not stuck by budget. One experiment is capped at 100 rounds.
- **Self-play overfits to itself.** Connect-4 self-play beat the previous
  champion head-to-head (0.57) but got worse against fixed opponents
  (0.65 vs 0.715). Over 5 replicates the drop is smaller: 0.6825 ± 0.013.
- **A league of past champions did not fix it.** Same budget, 5 replicates:
  league 0.6985 vs self-play 0.6825 vs fixed, difference +0.016 ± 0.023, and
  neither beat the starting 0.715. In rock-paper-scissors the league froze on
  a best response to its own early members in 5 of 5 seeds: it grows only on
  acceptance, so it needs members from outside the champion line (exploiters).
  With exploiters the latest champion still ended pure (exploitability 1),
  while the league's average mix reached 0.09 to 0.18. In non-transitive
  spaces ship the mixture, and drop "no regression on any member": holding
  scores against obsolete members pins the champion to exploiting them.
  [examples/league](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/league/). A second design (league in the plan, 0.5 par per
  opponent, no Holm) gave the same answer: league 0.6915 ± 0.016 vs self-play
  0.6825 ± 0.013, difference +0.009 ± 0.012. The league loses the self-play
  head-to-head edge over v2 (0.4985 vs 0.5445) but gains nothing against the
  fixed opponent. [examples/connect4](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/connect4/#league-vs-self-play-experiment-2-criteria-written-before-the-run).
- **Colonel Blotto closed the league topic.** 20 soldiers on 5 fields, a
  version is a mix of 4 distributions, 400 rounds per arm, 10 seeds. Every
  final champion in "beat the last", league and league+exploiter ended at
  exploitability 1 (random start: 1), difference 0.000 ± 0.000. A mix of 4
  can reach 0.5: random search found it in 9000 evaluations. So the bottleneck
  was local search around one champion, and no acceptance rule fixed it. Only
  the average over past champions improved, and it improved most where the
  champion cycled most: 0.59 for "beat the last" (76 accepts), 0.80
  league+exploiter, 0.85 league. In a cyclic game ship the mix of past
  champions and prefer the rule that gives the most varied history, not the
  strictest one. [examples/blotto](https://github.com/vadimchirkov/mutara/tree/d0320e4/examples/blotto/#results-measured-once-2026-10-03).

## Limits of greedy search, and the fix

- **Coordinated deviations are invisible to hill-climbing.** In Kuhn poker,
  bluffing loses chips against an honest opponent and the only profitable
  greedy moves are exploits the validation opponent punishes: 48 trials,
  0 accepted, exploitability stuck at 0.167.
- **Swap the candidate source, not the core.** CFR in `propose`, with regrets
  and the average strategy stored inside the version, turns one engine round
  into one CFR iteration. Result: exploitability 0.0089 after 300 rounds (3-link
  chain). The engine still provides journal, lineage, budgets and recovery.
- **Local mutation in `optimize`: not added to the core.** [search-bench](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/search-bench/)
  compared the built-in `randomPropose` with a 1-2 dimension Gaussian mutation
  of the champion, 10 seeds per cell, criterion fixed before the run. With the
  default `bounded` rule neither generator got a single candidate accepted in
  360 runs, so the generator made no difference. With `heuristic` and small
  noise (σ = 0.01) local mutation won 4 of 6 cells at d = 5 and 10, and also 2 of
  3 at d = 2. With noise comparable to the per-round gain (σ = 0.1) it won 1 of
  6: both generators accepted 9-26 of 50 candidates on noise and drifted. The
  acceptance rule and evaluation noise decide the outcome before the generator
  does. Users who need local search pass it through `propose`, as Lunar does.
- **Which evaluation fixes pay off.** [eval-bench](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/eval-bench/) tested five
  levers on a synthetic 5-field extraction task, 10 seeds, same budget unless
  noted. Same dice for baseline and candidate on each case gave the largest
  gain: with local mutation true pass rate 0.67 to 0.90, bad accepts 8 to 0 per
  run. Partial credit beat all-or-nothing by 0.14-0.30. A noisy judge cost 0.22;
  spending 3× on judge averaging or on 3× cases did not win it back
  significantly. More cases per round at a fixed budget hurt (fewer candidates):
  10×50 lost 0.22 to 50×10. `bounded` and `sequential` accepted 3 candidates in
  80 runs. Order of fixes: share randomness, score partially, score exactly,
  then think about sample size. Strict rules go in the final audit.
- **Shared seeds did not help on Lunar Lander.** Same check on a real
  simulator ([plan and numbers](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/eval-bench/#real-task-check-lunar-lander-plan-written-before-the-run)):
  10 campaigns with shared episode seeds vs 10 where the candidate flew other
  seeds. Audit return 218.5 ± 10.7 vs 215.0 ± 7.3, difference +3.5 ± 15.5.
  Per-episode returns of two controllers on one seed correlated only 0.00-0.29,
  so there was little shared noise to cancel. Shared randomness pays off only
  when outcomes on the same case move together; check that correlation on a
  few cases before counting on it.
- **Racing did not beat a small fixed sample.** [racing](https://github.com/vadimchirkov/mutara/tree/2d1f300/examples/eval-bench/#racing-plan-written-before-the-run)
  dropped a candidate after 3+ pairs once mean gain + 1 SE < 0 (`race`), and
  in `race2` also stopped clear winners (mean - 2 SE > 0). Equal budget of 1000
  evaluations, 10 seeds, 4 generator × scorer cells. One significant result in
  16 comparisons: `race2` over 10 pairs per candidate with local mutation,
  +0.17 ± 0.07; over 5 pairs it was +0.14 ± 0.09, not significant. With random
  search losers are obvious anyway, so 5 pairs per candidate already wastes
  little. With local mutation candidates are near-ties and `race` ran them to
  the cap. If racing gets another try, stop near-ties too: cap pairs low or
  stop when the interval is narrower than the gain that matters.
  Engine limit found on the way: when the next trial cannot reserve its cases,
  `optimize` fails with "Evaluation budget exhausted" instead of finishing. A
  fixed budget with variable-length trials therefore needs a trial cap and
  post-hoc truncation, as racing.mjs does.

## Machine-invented features

- A generator wrote 14 features in one shot, none of them the human ones. After
  an offline quarantine (determinism, valid output, no throws), selection
  reached 0.70 from 0.47. Human features scored 0.83.
- One feedback round (paired loss patterns → 8 refinements) closed the gap
  to −0.04. There was no third round on purpose: each look at the held-out set
  spends its independence. Pre-register the bet and cap the rounds.

## Cost

- Measure the price of one evaluation before wiring the engine. A Pong game
  costs 0.15 ms, so a round is centiseconds with a reactive policy, and tree
  search per decision (~1000×) was ruled out before any code was written.

## Agent loops (autoresearch)

A Karpathy-style loop (an agent edits code, the commit stays if validation improves,
otherwise reset) was measured with Mutara in two roles. The example was removed after
the measurement; code, method and raw numbers are in
[examples/autoresearch at 5ab62a4](https://github.com/vadimchirkov/mutara/tree/5ab62a4/examples/autoresearch).

- **Per-step keep rule: no gain.** Simulation with known ground truth, 10,100
  evaluations per run for every rule, 100 seeds. Mutara's sequential test as the keep
  rule found less than naive keep/discard: 12 to 39 pp less in the early regime, at best
  +0.2 ± 0.2 pp in the late one. The criterion was written before the run; no
  configuration passed.
- **Final audit: works.** One gate, champion vs start on fresh cases, promoted a branch
  without a true gain in at most 1 of 100 runs for any rule. The naive loop claimed
  +9.5 pp in the late regime for a true +0.2 pp.
- **Real loops** (retrieval, Lunar Lander controller, a JS hot path; 20 steps of
  `stealth/space-bunny-alpha`): all three final audits promoted real gains. Gating every
  kept commit against the previous one, 7 of 22 kept steps held up. In retrieval, eight
  steps after BM25 raised validation by 0.086 on 30 claims and changed nothing on 300
  fresh ones. In Lunar Lander the shipped champion was worse than its own step 5 (0.713
  vs 0.757 on fresh seeds, decided at 155 seeds).
- **Time each case in its own process.** Identical code timed in one process drew
  shares of 0.499, 0.509 and 0.503 across three processes: a shared offset that breaks
  the independence the gate assumes.

So Mutara drives a loop only when a candidate fits in one value that `reflect` or
`propose` returns. For loops where an agent edits files and git holds the state, run
one `gate` at the end.
