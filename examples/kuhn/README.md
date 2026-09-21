# Kuhn poker starter (hidden information — negative result)

Fourth game on the same scaffold as `../tictactoe`. No changes to `src/` or TEOB.
Tests the dimension the other games lack: the opponent's card is hidden, so
value-betting is not enough — the policy must bluff and catch bluffs.

* Ante 1, one bet of 1, cards J/Q/K. Version = 12-number information-set policy
  (P1 open / P2 after check / P1 facing bet / P2 facing bet × J/Q/K) on a 0.1 grid,
  playing both seats. Start: honest (value-bet/call Q,K, fold J, never bluff).
* Only 6 deals, so evaluation is exact EV — zero noise. Train vs HONEST, validate
  vs TRICKY (fixed, disjoint). Overfitting one fixed opponent is possible, so the
  held-out is exact exploitability (0 = Nash), never used for selection.
* Case discipline: no seeds needed; proposer rng comes from plan seed + round.
* `recovery: repeatable`, cost 0.
* Gate (documented host choice): exact gain on train and validation (both seats,
  12 deal-seats) plus more improved deal-seats than regressed.

```bash
pnpm run build
node examples/kuhn/bench.mjs kuhn-comp-v4 ./examples/kuhn/learning.db
```

## Result: the method plateaus, honestly

Measured (`kuhn-comp-v4`, 48 rounds, instant): 48 trials, **0 accepted**.
Every nontrivial candidate loses on train or validation. The champion stays
honest: exploitability `0.167`, same as initial.

Why: bluffing is a coordinated deviation, not a greedy improvement. Against
HONEST (never folds Q/K) every bluff loses chips; the only winning deviations
are exploitative folds (fold Q into a K-only range) that TRICKY (which bluffs)
punishes. Single- and double-dim hill-climbing from honest play cannot cross
that gap — it needs co-adaptation (self-play) or equilibrium solving.

## Ceiling (`ceiling.mjs`)

Vanilla CFR, deterministic, 10000 iterations (~0.1 s). Measured:
exploitability `0.0045` (≈ Nash), recovered policy matches the textbook
α-family (P1 bluffs J ~0.2, value-bets K ~0.65, calls Q ~0.55 facing a bet).

## CFR through the engine (`cfr.mjs`, `cfr-bench.mjs`)

The gap above is closable without touching the core: regrets and the average
strategy live inside the version (finite JSON, digest-pinned), so one engine
round = one exact CFR iteration — `propose` does the update (sync,
deterministic, pure), the engine contributes journaling, lineage, budgets and
recovery. `assess` always accepts; the Nash approximation is the average
strategy (`finalPolicy`), not the last policy.

Two findings along the way, both kept in the code as comments:

* The engine caps one experiment at 100 rounds, so the run is a 3-link
  supervisor chain (`kuhn-cfr-v1-l1..l3`); regrets survive the handoff inside
  the version.
* The profile is read at infoset-visit time (textbook Neller–Lanctot form).
  A frozen-profile variant was tried first and stalls at honest-level
  exploitability (`0.167`); the visit-time form converges.

```bash
node examples/kuhn/cfr-bench.mjs ./examples/kuhn/cfr.db
```

Measured once (3 links × 100 rounds, ~0.2 s): 300 iterations, exploitability
`0.0089` (hill-climb champion: `0.167`, direct CFR at 10000: `0.0045`),
recovered policy matches the α-family. The Kuhn arc is closed both ways:
greedy search plateaus, equilibrium solving converges — same contract.

## Bug found and fixed along the way

`kuhn-comp-v1/v2` evaluated the version as P1 only, leaving all 6 P2-side dims
dead (exactly `0.0000` deltas). `v3` scores both seats (P2 values flipped to the
version's view, 12 deal-seats). The plateau above is measured with the fix.
