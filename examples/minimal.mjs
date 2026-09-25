import assert from "node:assert/strict";
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, plan } from "../skills/mutara/assets/adapter.mjs";

const learner = learnerHarness(":memory:", adapter);
try {
  await learner.start("threshold-demo", plan);
  const result = await learner.wait("threshold-demo");
  assert.equal(result.champion.config.threshold, 0.5);
  assert.deepEqual(result.trials.map((trial) => trial.accepted), [true, true, false]);
  const rejected = result.trials.at(-1);
  assert(rejected.evaluation.trainingGain > 0);
  assert(rejected.evaluation.validationGain < 0);
  assert.equal(result.spent, 0);
  console.log(JSON.stringify({
    before: plan.initial.config,
    after: result.champion.config,
    accepted: result.trials.map((trial) => trial.accepted),
    rejectedTrainingWinner: rejected.evaluation,
    executions: result.executions,
    cost: result.spent,
  }, null, 2));
} finally {
  await learner.close();
}
