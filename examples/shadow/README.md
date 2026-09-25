# Shadow evaluation — test a new prompt against production logs

Your agent already answers users in production. You want to try a new prompt
without risking live traffic. This example shows the pattern:

```
production log        challenger prompt
  (already ran)         (new, untested)
       ↓                      ↓
  replay outputs         call LLM (or simulate)
       ↓                      ↓
       └──── compare ─────────┘
                  ↓
            accept / reject
```

## What it does, step by step

1. **Production log** — a JSON file with requests your champion already
   answered: `{ id, input, label, championOutput }`. In real use, export this
   from your database, logging pipeline, or observability tool.

2. **Champion (baseline)** — the harness replays champion outputs from the log.
   No API call, zero cost. The champion already paid for these.

3. **Challenger (candidate)** — the harness calls the new prompt on the same
   inputs. In this example it's simulated; replace `callChallenger` with a real
   LLM call. Each call costs money and is tracked in the budget.

4. **Grade** — compare each output against the ground-truth label. Score:
   accuracy (correct or not).

5. **Gate** — if challenger accuracy > baseline accuracy → accept. The harness
   journals the decision. Crash mid-run → resume from journal, no double calls.

## Run

```bash
pnpm run build
node examples/shadow/run.mjs
```

Expected output:

```
baseline accuracy: 0.583  (champion got 7/12 right in production)
challenger accuracy: 1.000  (challenger got 12/12 right)
→ accepted
```

## Adapt to your system

1. **Replace `production-log.json`** with real production data. Minimum fields:
   `id`, `input`, `label` (ground truth), `championOutput`.

2. **Replace `callChallenger`** with a real LLM call:
   ```js
   async function callChallenger(input, prompt) {
     const res = await llm.complete({ system: prompt, user: input });
     return { output: res.text, cost: res.usage.totalCost };
   }
   ```

3. **Set `costLimit` and budget** in `limits()` to cap spending.

4. **Use a file-backed DB** instead of `:memory:` for crash recovery:
   ```js
   const learner = learnerHarness("./shadow.db", adapter);
   ```

5. **Swap the gate** for statistical significance (bounded mode) when you have
   enough samples — see `decision.ts` in the library.

## What this is NOT

This is not a live traffic interceptor. Mutara doesn't sit in your HTTP stack.
You collect the production data yourself (from logs, traces, or a queue) and
feed it here. The harness does the comparison, gating, journaling, and recovery.
