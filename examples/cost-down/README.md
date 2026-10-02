# Cost-down: move extraction to a cheaper model, ship only with proven parity

A team runs payment extraction on an expensive model with a prompt that states its
output conventions. They want a cheaper model. This example measures three setups on
the same 300 fresh cases, each against the expensive production setup:

- **naive**: cheap model, production prompt unchanged
- **optimized**: cheap model, prompt tuned by `optimizeReflective` on train/validation only

Each cheap arm goes through `gate` with a non-inferiority margin (default 0.03 on a
0–1 field-accuracy score): it is promoted only if the paired test shows it is at most
that much worse, and it produced no more non-JSON replies.

The task is the hard level of [reflective-bench](../reflective-bench/): business rules
(fees, "1.2k", chargebacks, intermediaries, date order by currency) that the production
prompt does not state. Cases are generated locally from fixed seeds; the gate's fresh
cases (seeds 5000+) never enter tuning.

## Run

```bash
pnpm run build
node examples/cost-down/run.mjs /tmp/cost-down-dry --dry   # stubs: wiring only
```

With real models through any OpenAI-compatible endpoint:

```bash
MUTARA_LLM_BASE_URL=https://openrouter.ai/api/v1 MUTARA_LLM_API_KEY=... \
EXPENSIVE_MODEL=openai/gpt-4.1 CHEAP_MODEL=openai/gpt-4.1-nano \
EXPENSIVE_PRICE=3.5 CHEAP_PRICE=0.18 \
  node examples/cost-down/run.mjs ./reports/cost-down-1
```

Prices are blended USD per 1M tokens; without them costs are tokens. `REFLECT_MODEL`
defaults to the expensive model. Re-running the same directory resumes from the
journal. `report.json` holds both verdicts, means, violations and the cost ratio.

## Results

**Not measured yet.** The dry run checks wiring only: with scripted stubs (expensive
97% right, cheap 85% or 97% once tuned) the naive arm is `inconclusive` at exactly the
margin and the optimized arm is promoted after 217 of 300 pairs.

## Caveats

- Parity needs cases: about `6 / margin` pairs even when outputs are identical (see
  [gate.md](../../skills/mutara/references/gate.md)). 300 fresh cases resolve a 0.03
  margin, not 0.02.
- The production prompt here is hand-written, standing in for a team's tuned prompt.
  A stronger production prompt makes the cheap arms harder to promote.
- Generated cases are one distribution. Use your own logged cases for a decision.
