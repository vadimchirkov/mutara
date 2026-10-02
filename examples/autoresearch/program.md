# Additions to an autoresearch `program.md`

Paste these into your `program.md` (Karpathy's [autoresearch](https://github.com/karpathy/autoresearch)
or any fork). The loop itself stays as it is: keep a commit when the validation metric
beats the best so far, otherwise `git reset`. Mutara checks the branch once, at the end.

## Setup (add)

- Record the starting commit: `git rev-parse HEAD > .autoresearch-base`.
- The audit harness (`EVAL_CMD`) and the fresh case list (`CASES`) live outside this
  repository or in files you must never read or edit. You see only the audit's exit code,
  never per-case scores.

## Results (replace "report the best val metric")

When the human stops the loop, run the audit once: the current champion against the
starting commit.

```bash
BASE=$(cat .autoresearch-base) HEAD=$(git rev-parse HEAD) \
EVAL_CMD=<harness> CASES=<fresh case list> \
  npx teob-mutara gate gate.config.mjs --out audit.json > /dev/null 2>&1
echo "audit exit: $?"
```

Report the exit code as the result of the run, next to the validation numbers:

- `0` promote: the gain over the starting commit holds on fresh cases.
- `1` reject: the champion is not better than the start. Say so.
- `3` inconclusive: the fresh cases could not tell. The validation gain is unconfirmed.
  Do not describe it as an improvement.
- `2` error: report the error. Do not retry with other cases.

Run the audit once per loop. Auditing again after more edits, or with other cases, turns
the fresh cases into a second validation set.
