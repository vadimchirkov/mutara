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
  (0.65 vs 0.715). The next step would be a league of past champions.

## Limits of greedy search, and the fix

- **Coordinated deviations are invisible to hill-climbing.** In Kuhn poker,
  bluffing loses chips against an honest opponent and the only profitable
  greedy moves are exploits the validation opponent punishes: 48 trials,
  0 accepted, exploitability stuck at 0.167.
- **Swap the candidate source, not the core.** CFR in `propose`, with regrets
  and the average strategy stored inside the version, turns one engine round
  into one CFR iteration. Result: exploitability 0.0089 after 300 rounds (3-link
  chain). The engine still provides journal, lineage, budgets and recovery.

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
