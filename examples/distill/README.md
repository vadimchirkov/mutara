# Amplify, then distill: AlphaZero's improvement loop without weights

AlphaZero makes its network stronger by search (MCTS) and then trains the
network to repeat what search found. Here the "network" is one call to a
model with a prompt, and there are no weights to train:

- **Teacher (amplified):** the same model, asked to reason first, 5 samples
  at temperature 0.7, field-wise majority vote. About 5x the calls, plus
  reasoning tokens.
- **Student:** the same model, one call, JSON only, temperature 0. Its prompt
  is tuned by `optimizeReflective` to agree with the teacher's answers.
- **No labels in training.** The optimizer scores the student against the
  teacher's vote, never against the true answer. True answers are used only
  by `gate` on 300 fresh cases.

The task is the hard payment extraction from
[reflective-bench](../reflective-bench/), the same as
[cost-down](../cost-down/). The student starts from cost-down's production
prompt; the teacher gets the same prompt plus "reason first".

Teacher outputs for train, validation and fresh cases are produced once by a
journaled labeling experiment (one job per case). Both gates replay those
journaled outputs and costs as the baseline, so the teacher is paid for once.

## Run

```bash
pnpm run build
node examples/distill/run.mjs runs/distill-dry --dry   # stubs: wiring only
MUTARA_LLM_BASE_URL=https://openrouter.ai/api/v1 MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... \
  node examples/distill/run.mjs runs/distill-1 [--rounds 8] [--concurrency 4]
```

`TEACHER_MODEL` and `STUDENT_MODEL` override `MUTARA_LLM_MODEL` per role;
the reflector uses the teacher model. Costs are tokens.

## Criteria, written before the real run

Two gates on the same 300 fresh cases, each against the teacher, score =
field accuracy against the true answer, non-inferiority margin 0.03:

- `naive`: student model, production prompt, one call.
- `distilled`: student model, prompt tuned on teacher votes only.

Pass if all three hold:

1. `naive` is not promoted. Otherwise amplification bought nothing on this
   task and the distillation result is moot; recorded as such.
2. `distilled` is promoted.
3. `distilled` costs at most 1/3 of the teacher in tokens on the gate cases.

Reported without a criterion: teacher, naive and distilled accuracy against
the truth, teacher label accuracy on train and validation, tuning accepts.
One run, one model: a pass is one data point.

## Dry run (2026-10-03): wiring only

`node examples/distill/run.mjs runs/distill-dry --dry` finishes in about
1.5 seconds; a rerun on the same directory adds no journal events. The stub
numbers say nothing about a real model.

Rough size of the real run with the defaults: 1900 teacher calls with
reasoning (380 cases x 5), about 1500 student calls in tuning, up to 600 in
the gates. Around 2 to 3M tokens.

## Real run (2026-10-03): fail, nothing to distill

```bash
MUTARA_LLM_BASE_URL=https://openrouter.ai/api/v1 MUTARA_LLM_MODEL=stealth/space-bunny-alpha \
  node examples/distill/run.mjs runs/distill-2
```

One model, both roles. All 300 fresh pairs ran in both gates.

| | Accuracy vs truth | Non-JSON replies | Tokens on gate cases |
|---|---|---|---|
| Teacher (reason + 5-sample vote) | 0.889 | 0 | 1,043,478 |
| Naive student | 0.875 | 1 | 118,068 (11%) |
| Distilled student | 0.872 | 1 | 119,696 (11%) |

1. Naive not promoted: met, but on a technicality. The gate rejected it for
   one non-JSON reply (violations grew from 0 to 1). On accuracy it is 0.014
   behind, inside the 0.03 margin; the test was not yet decisive either way.
2. Distilled promoted: not met. Tuning accepted nothing in 8 rounds, so the
   distilled prompt is the production prompt and the gate repeats the naive
   result (same reject, same reason).
3. Cost: met, the student uses 11% of the teacher's tokens.

Verdict: fail.

Why. The student already agreed with the teacher on 96% of train fields and
97% of validation fields before tuning. Reflection found candidates that
fixed the screened failures (screen 0.75 to 1.0 in 7 of 8 rounds) but none
beat the parent on the full train and validation sets. The teacher is 0.889
against the truth and the student 0.875: about 11% of fields are wrong for
both, the business rules the prompt does not state. Five votes remove random
slips, which are rare at temperature 0; they cannot add a rule neither run
knows.

AlphaZero's search adds information: it plays the position forward against
the real rules. A vote of the same model adds almost none. Amplification
that is worth distilling needs an outside source of truth: a stronger model,
a checker, a tool. The first attempt (`runs/distill-1`) stopped after 5
calls on a provider error returned with HTTP 200; the shared client now
retries those.
