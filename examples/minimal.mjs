import assert from "node:assert/strict";
import { learnerHarness } from "mutara/sqlite";
import { adapter, plan } from "../skills/mutara/assets/adapter.mjs";

const learner = learnerHarness(":memory:", adapter);
try {
  await learner.start("threshold-demo", plan);
  const result = await learner.wait("threshold-demo");
  assert.equal(result.champion.config.threshold, 0.5);
  assert.deepEqual(result.trials.map((trial) => trial.accepted), [true, true, false]);
  assert.equal(result.spent, 0);
  console.log(JSON.stringify({
    before: plan.initial.config,
    after: result.champion.config,
    accepted: result.trials.map((trial) => trial.accepted),
    executions: result.executions,
    cost: result.spent,
  }, null, 2));
} finally {
  await learner.close();
}
