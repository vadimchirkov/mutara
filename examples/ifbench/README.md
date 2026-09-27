# IFBench: Mutara vs GEPA

This compares Mutara and GEPA on IFBench, a public instruction-following benchmark that the
GEPA paper also uses (Agrawal et al. 2025, "GEPA: Reflective Prompt Evolution Can
Outperform Reinforcement Learning"). Both systems use the same model, reflector, splits and
budget. Only our own runs are compared. We do not copy the paper's numbers, because it used
different models and budgets.

```bash
node examples/ifbench/fetch.mjs
```

```bash
MUTARA_LLM_BASE_URL=https://api.openai.com/v1 MUTARA_LLM_API_KEY=... MUTARA_LLM_MODELS=model-a,model-b node examples/ifbench/all.mjs runs/ifbench-v1
```

`all.mjs` runs the full matrix: every model × seeds 7919, 2718, 31415 × {Mutara, GEPA}. Each
run also scores the initial program on the test split. At the end it prints the table.
`node examples/ifbench/compare.mjs DIR` prints the table again from an existing directory.
You need Node, `uv` and network access for the pinned Python packages. To use an existing
interpreter that already has them installed, set `IFBENCH_PYTHON=/path/to/python`.
`MUTARA_REFLECT_MODEL` sets the reflector (by default it is the task model), and
`MUTARA_LLM_TEMPERATURE` sets the task temperature (default 0.6). The reflector always runs
at temperature 1.0. The API key never reaches a journal, report or ledger. Rerunning
with the same directory skips finished runs and resumes unfinished ones. `--dry` swaps in a
stub model: use it to check the wiring. It measures nothing.

## Method

- **Data.** `fetch.mjs` downloads everything into the gitignored `data/` directory from the GEPA
  paper's artifact ([gepa-ai/gepa-artifact](https://github.com/gepa-ai/gepa-artifact) at a
  pinned commit, MIT). The artifact vendors the official allenai checkers
  ([allenai/IFBench](https://github.com/allenai/IFBench), Apache-2.0), IFBench test data and
  IF-RLVR train data (`allenai/IF_multi_constraints_upto5`, ODC-BY). `data/manifest.json`
  records sha256 hashes. Do not commit `data/`.
- **Splits (GEPA's, reproduced exactly).** The artifact's `ifbench_data.py` and
  `benchmark.py` define them: validation is `IFBench_train[:300]`, train is
  `random.Random(1).sample(IFBench_train[300:600], 150)` (drawn with Python's own RNG), and
  test is all 294 rows of `IFBench_test`. The test split uses constraint types that never
  appear in train or validation.
- **Score.** Each case scores the fraction of its constraints that the final response
  satisfies. `metric.py` ports GEPA's `metric_with_feedback` without the dspy wrapper: it
  uses the same loose matching and the same feedback text. The feedback lists which
  constraints were followed and which were violated, and it is the reflector's input on
  both sides. Mutara scores each rollout inside its task job, because the checker needs
  the constraint kwargs. The model never sees those kwargs.
- **Program.** Both sides run GEPA's `IFBenchCoT2StageProgram`: `generate` drafts a
  response, then `ensure` rewrites it into the final response. Both start from the same two
  instructions, the artifact's signature docstrings. The call format differs. GEPA runs
  the program in dspy, using `ChainOfThought` with dspy's chat adapter. Mutara sends two
  plain chat calls, with the instruction as the system message. So each side's initial
  program gets its own test score, and the table reports both.
- **Budget.** The budget unit is the metric call: one full rollout scored once, on train or
  validation. It is capped at **3593**, the value the artifact uses for IFBench
  (`get_max_invocations`, matched to MIPROv2-Heavy). GEPA receives it as `max_metric_calls`.
  Mutara receives it as `budget.cost` with a cost of 1 per rollout. Reflection calls are
  outside the budget on both sides, as in GEPA, and so is the test evaluation. GEPA may run
  slightly past its cap, because it checks the budget between iterations. Mutara stops
  before any round it cannot fully reserve, and it also stops after 100 rounds, its
  maximum. That cap can end a run below 3593. The table reports the metric calls each side
  actually spent.
- **Settings matched to dspy.GEPA's defaults.** Minibatch 3 (`maxFailures: 3`), Pareto
  parent selection, up to 5 merges, round-robin components, and a 4000-token cap per task
  call (8000 for the reflector). dspy's cache is off, so every rollout is a paid call on
  both sides. Mutara runs 8 jobs at once (`concurrency: 8`) and GEPA uses 8 threads.
- **Accounting.** `proxy.mjs` is a local OpenAI-compatible proxy, and both systems send
  every call through it. It appends each completed call to `ledger.jsonl` in the run's
  directory, so calls and tokens are counted the same way outside either system. Wall time
  covers optimization in the last process that ran.
- **Test.** Test scores come only from the 294 held-out cases. Train and validation scores
  are optimistic, because selection used them. The paired test takes each case's champion
  score averaged over the 3 seeds, then runs `sequentialDecision` (anytime-valid) on
  Mutara − GEPA in both directions, with alpha 0.05 Bonferroni-split over
  2 × models comparisons.

## Results

**Not measured yet.** The session that built this benchmark had no model endpoint or
credentials, and it could not install the Python checker environment. The table will be
filled from `all.mjs` output. If Mutara loses, this README will say so.

| Model | Program | Test score, % (mean ± sd, 3 seeds) | Metric calls | LM calls | Tokens | Optimize wall, s |
|---|---|---|---|---|---|---|
| — | Initial (plain chat) | | — | — | — | — |
| — | Initial (dspy) | | — | — | — | — |
| — | GEPA | | | | | |
| — | Mutara | | | | | |

Paired Mutara − GEPA per model: pending.

## Crash recovery

```bash
node examples/ifbench/crash.mjs runs/ifbench-crash-v1 --dry --budget 1200 --kill-at 500
```

For each system, `crash.mjs` runs once without interruption. It then starts a second run,
sends SIGKILL to the whole process group once the ledger shows `--kill-at` paid calls,
and restarts on the same directory until the run finishes. The ledger belongs to the
proxy, so it survives the kill and counts every completed call, including calls whose
results the killed process lost.

| System | Calls, uninterrupted | Calls, killed + restarted | Extra | Same champion and test score |
|---|---|---|---|---|
| Mutara | 2188 | 2200 (508 before the kill) | 12 | yes |
| GEPA | not measured | | | |

The Mutara row was measured with the stub model and a stand-in scorer. It shows which calls
get paid twice, which depends on orchestration and not on the model. It says nothing about
quality. Finished jobs were never executed again. The 12 extra calls were work in flight
at the kill: with `repeatable` recovery, a job whose receipt was not yet journaled runs
again. The bound is 8 concurrent jobs × 2 calls. `manual` recovery would block on those
jobs instead of paying for them again. The GEPA row needs the dspy environment, which was
unavailable when this benchmark was built. dspy.GEPA resumes its search from `log_dir`. Its
test evaluation is not checkpointed, so a kill during the test phase pays for that phase
again.
