# Reflective benchmark: payment extraction with hidden conventions

Measures whether `optimizeReflective` improves a prompt with a real model. Each
case is a payment message ("Refund from Soylent AG of €496,92 received Feb 2
2023."); the answer is JSON with `amount`, `currency`, `date`, `vendor`. The
evaluator expects conventions the initial prompt never states: amount as a string
with two decimals (none for JPY), negative for refunds, ISO currency code, ISO
date, vendor upper-cased without its legal suffix. Only evaluator feedback on
train failures reveals them, which is what reflection is supposed to exploit.

Cases are generated locally from fixed seeds (`task.mjs`): 30 train, 30
validation, 60 final. Final cases are never shown to the reflector or used for
selection; `finalAudit.test` is a paired anytime-valid test of champion vs.
initial prompt on them (α = 0.05).

## Run

Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, vLLM, Ollama, LM
Studio, Anthropic's OpenAI-compatible API):

```bash
pnpm run build
MUTARA_LLM_BASE_URL=https://api.openai.com/v1 MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=gpt-4o-mini \
  node examples/reflective-bench/run.mjs ./reports/payments-1 --rounds 8
```

`MUTARA_REFLECT_MODEL` sets a different (usually stronger) reflector model.
Cost units are tokens (prompt + completion); the budget is 2M tokens. The same
command with the same directory resumes after a crash without repeating
finished calls. Behaviour or model changes need a new directory. The key is read
from the environment and never journaled.

`--dry` replaces the model with a scripted stub to check wiring; it measures
nothing.

## Reading the report

`report.json` has the final audit (initial vs. champion on final cases, with the
test verdict), per-round screen/gate outcomes, tokens, wall time and mean call
latency. Report gains only from `finalAudit`; train/validation numbers were used
for selection and are optimistic. One run on one model is one data point.
