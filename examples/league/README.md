# League of past champions (AlphaStar idea, no weights)

Self-play tunes a strategy against its own latest version. In Connect-4 that
beat the previous champion head-to-head (0.57) and got worse against fixed
opponents (0.65 vs 0.715), see [LESSONS.md](../LESSONS.md). AlphaStar's fix is
a league: every frozen past version stays in the pool, and a new version has
to hold up against all of them.

Here the league lives inside the version. When a candidate is accepted, the
old champion joins its league, so lineage and the league travel together
through the journal. No changes to `src/`.

Acceptance rule (league): the candidate's mean score over the league beats the
champion's on the same games, and no single member shows a significant
regression beyond a margin (Holm correction over members, so a growing league
does not block everything by chance).

## Criteria, written before the first league run

Fixed before any league code ran. Not changed after.

**Experiment 1, rock-paper-scissors** (`rps.mjs`, exact payoffs, no sampling).
Same proposer, same seeds, 5 proposer seeds, 200 rounds each.

- "Beat the last": accept a candidate that beats the current champion.
- "League": mean over league above the champion's, no member worse than the
  champion's own result by more than 0.05.
- Pass: in at least 4 of 5 seeds, "beat the last" ends with exploitability
  >= 0.3 and the league ends with exploitability <= 0.1. Exploitability =
  best pure response payoff against the final champion (0 = uniform mix).

This is an illustration of the mechanism, not evidence of value.

**Experiment 2, Connect-4 5x5** (`../connect4/league-bench.mjs`). Same
proposer, rounds and seeds as the measured self-play chain (3 links x 8
rounds, 64 train + 64 validation games per side), 5 replicates (replicate 0
uses the original seeds). Fixed opponent: MCTS-15 baseline, 200 held-out games,
the metric behind 0.715 and 0.65.

- Pass: league mean `vsFixed` >= 0.715, and league minus self-play `vsFixed`
  > 2 standard errors of the paired difference across replicates.
- Budget: both arms get the same rounds. The league also plays the champion
  on the same seeds (paired); those games are cached, and the report lists
  games played per arm.
- If it fails, the result goes to LESSONS.md as a negative result.

## Results (measured once, 2026-10-03)

Both experiments failed their criteria.

**Experiment 1, RPS: fail, 0 of 5 seeds.**

```bash
node examples/league/rps.mjs runs/league/rps.db 5 200
```

"Beat the last" cycled as expected: 42 to 72 accepted champions, final
exploitability 0.5 to 0.75, final champion vs its own history -0.03 to 0.04.
The league stopped at pure paper in all 5 seeds (exploitability 1) after 5 to
7 accepts. 200 rounds ran as two chained experiments of 100, because one
experiment is capped at 100 rounds.

Why: the league only grows when a candidate is accepted. Early champions are
rock-heavy, pure paper is the best response to that league, so nothing beats
paper on it, nothing is accepted and the league freezes. Post-hoc ablation,
not part of the criterion: dropping the per-member rule (margin 2, mean only)
gives the same result in all 5 seeds. A league of past champions alone cannot
leave a best response to its own past. It needs new members from outside the
champion line, which is AlphaStar's exploiter role.

**Experiment 2, Connect-4: fail.**

```bash
node examples/connect4/league-paired-bench.mjs runs/c4/league-bench.db 5
```

| Replicate | Self-play `vsFixed` | League `vsFixed` | League accepts per link |
|---|---|---|---|
| 0 (original seeds) | 0.65 | 0.725 | 1/0/1 |
| 1 | 0.715 | 0.6525 | 1/0/0 |
| 2 | 0.6525 | 0.695 | 1/0/1 |
| 3 | 0.6925 | 0.70 | 1/0/0 |
| 4 | 0.7025 | 0.72 | 1/1/1 |
| Mean ± SE | 0.6825 ± 0.013 | 0.6985 ± 0.013 | |

Starting champion (v2): 0.715. League minus self-play: +0.016 ± 0.023,
below the 2 SE bar, and the league mean is under 0.715. Games played: 3072
self-play, 3254 league on average (champion games cached).

Replicate 0 reproduced the recorded self-play numbers exactly (0.65 vs fixed,
0.5725 vs v2), so the code is the same. The other replicates show the 0.65 in
LESSONS was a low draw: self-play averages 0.6825. Neither arm improves on the
starting champion against the fixed opponent at this budget. Each held-out
score is 200 games, about ±0.03 per replicate, which is the size of every
effect here.

## Experiment 1b, league + exploiter (criteria written before the run)

`exploiter.mjs`. Main agent: 20 links of 10 rounds (200 main rounds). Before
each link an exploiter runs 10 rounds of the same proposer, starting from the
champion, accepting any candidate that scores higher against the frozen
champion. If the exploiter's result beats the champion (payoff > 0), it joins
the champion's league. Total 400 rounds, so "beat the last" gets 400 too.

Two league arms, each with its own verdict: per-member margin 0.05 (the
experiment 1 rule) and mean only (margin 2).

- Pass, per arm: in at least 4 of 5 seeds the final champion has
  exploitability <= 0.1, and "beat the last" after 400 rounds has >= 0.3.
- Reported, not in the criterion: exploitability of the league's average mix.
  AlphaStar ships a mixture over the league, not the latest agent.

### Result 1b (measured once, 2026-10-03): fail, both arms 0 of 5

```bash
node examples/league/exploiter.mjs runs/league/exploiter.db 5
```

| Seed | Beat last, 400 rounds | Margin 0.05: final / league avg | Mean only: final / league avg |
|---|---|---|---|
| 0 | 0.417 | 1 / 0.353 | 1 / 0.175 |
| 1 | 0.583 | 0.5 / 0.253 | 1 / 0.171 |
| 2 | 0.583 | 1 / 0.365 | 1 / 0.104 |
| 3 | 0.75 | 1 / 0.392 | 1 / 0.097 |
| 4 | 0.833 | 1 / 0.385 | 1 / 0.093 |

Exploitability, lower is better. Exploiters joined the league 17 to 20 times
out of 20 links in every run, so the league no longer froze.

- Margin 0.05: the champion stays on pure paper in 4 of 5 seeds. Any move off
  paper costs at least 1/12 against the rock-heavy early members, more than
  the margin, so the per-member rule blocks it even with exploiters in the
  league.
- Mean only: the champion ends on pure scissors in 5 of 5, the best response
  to a paper-heavy league average. The league average itself gets close to
  equilibrium: 0.093 to 0.175, at or under 0.1 in 3 of 5 seeds. This is
  fictitious play: the latest best response stays pure, the mixture
  converges.

What it means for Mutara. In a non-transitive space the thing to ship is the
league mixture, not the latest champion. That is also what AlphaStar ships.
"No regression on any past member" does not fit such a space: obsolete
members are exploitable, and holding their score pins the champion to
exploiting them. In transitive tasks (most prompts and settings) the rule
still makes sense, and Connect-4 showed no measurable cycle to fix.

## Next

- A transitive task where old weaknesses come back is the right test for a
  per-member rule: experiment 3, prompt injection families by week. The plan
  gated it on a Connect-4 pass, which did not happen; running it needs a new
  decision.
