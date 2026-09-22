# Jev + Mutara: structured judgment tuning for tic-tac-toe

Jev (TypeSafe System One) evaluates board positions. Mutara tunes the
evaluation strategy and journals every experiment.

```text
Per move (~100ms):  board → Jev Score questions → composite value → pick best move
Per batch:          Mutara compares weight sets → gate → promote champion
Tunable surface:    weights on natural-language evaluation dimensions
```

## The architecture

**Jev** is the evaluator — fast structured judgments, not text generation.
Each move, it answers three Score questions about the board (control, threat,
defense) and returns calibrated probabilities. Code combines them with weights.

**Mutara** is the judge — it runs candidates against the baseline on pinned
games, gates promotion, and journals every step. The built-in random search
varies the weights; a smarter generator (GEPA, LLM) could also propose new
questions or criteria.

**What's being tuned:** not code, not neural weights — the relative importance
of natural-language evaluation dimensions. Interpretable, inspectable, cheap.

## Run

```bash
# Mock mode (no API key, local heuristic — same protocol, proves wiring):
node examples/jev-ttt/run.mjs

# Jev mode (requires TypeSafe API key):
TYPESAFE_API_KEY=ts-... node examples/jev-ttt/run.mjs
```

Mock mode uses a local heuristic that mirrors the three dimensions Jev would
evaluate. Same Mutara protocol, same journal, same held-out check — just no
API calls. Switch to Jev mode to see the real system work.

## What this demonstrates

1. **Mutara as judge, not generator.** The optimizer varies weights (simple
   random search). The evaluation intelligence comes from Jev. A better
   generator would propose new questions or criteria — Mutara gates regardless.

2. **Natural-language features.** The "strategy" is three English sentences
   describing what matters on the board. Mutara tunes their relative weights.
   No domain-specific feature engineering.

3. **Cost accounting.** In Jev mode, each game costs ~4-5 API calls. Mutara
   tracks cumulative spend. A crash mid-experiment resumes without re-paying
   completed games.

4. **Held-out validation.** After selection, 100 games on fresh seeds measure
   the champion against the baseline. Never used during selection.

## Extending

- **Add evaluation dimensions:** add a Score question to `DEFAULT_STRATEGY.questions`
  and a weight to the optimizer space. Mutara will test whether it helps.
- **Tune criteria wording:** change what each Score level describes. The mock
  won't reflect this, but Jev will.
- **Smarter candidate generation:** replace Mutara's random search with GEPA or
  an LLM that proposes entire question-sets. Mutara still gates and journals.
- **Different game:** swap `game.mjs` and the Jev questions. The harness is
  domain-agnostic.

## Measured results

**Mock mode** (local heuristic, 10 trials × 20 samples):

| | Held-out (n=100) | Weights |
|---|---|---|
| Champion | **0.840** | control=0.61, threat=0.30, defense=0.02 |
| Baseline | 0.770 | control=0.30, threat=0.50, defense=0.20 |

Mock heuristic is deterministic → low noise → optimizer finds better weights.

**Jev mode** (real TypeSafe API, 10 trials × 10 samples, $0.20):

| | Held-out (n=100) | Weights |
|---|---|---|
| Champion | 0.640 | control=0.77, threat=0.99, defense=0.63 |
| Baseline | **0.770** | control=0.30, threat=0.50, defense=0.20 |

Champion lost on held-out — optimizer overfitted to 10 noisy samples. The
initial weights are already near-optimal for Jev's evaluation quality, and
random search over 3 continuous dimensions with 10 trials lacks the
resolution to improve on them. This is the same pattern as the crypto-paper
finding: the harness caught the overfit.

**What the $0.20 bought:** 200 Jev-evaluated game executions, journaled with
recovery. A crash at execution 150 would resume from 151, not re-pay the
first 150.

## Limitations

- Mock mode proves protocol, not Jev quality. Run with `TYPESAFE_API_KEY` for
  real evaluation.
- Random search over 3 weights is weak. This demonstrates the integration
  pattern, not optimal play. Component search (as in `examples/tictactoe/`)
  or LLM-driven question generation would be stronger.
- The 5-minute experiment timeout (`learnerHarness.wait`) limits Jev-mode
  trials. For larger runs, call `learnerHarness` directly with a custom timeout.
- No MCTS in this example. Adding Jev-backed MCTS would multiply API calls
  (~20 per move × ~5 moves × 20 samples × 10 trials = 20k calls). Use MCTS
  for turn-based games where lookahead matters and budget allows it.
