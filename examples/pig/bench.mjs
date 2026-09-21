// Pig component-search benchmark. New ID + new DB per run.
// Uses only public exports: mutara/sqlite.
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion } from "./strategy.mjs";

const id = process.argv[2] ?? "pig-comp-v1";
const storage = process.argv[3] ?? "./examples/pig/learning.db";

const plan = buildPlan({ rounds: 10, seed: 7919, minimumGain: 0.02 });
const learner = learnerHarness(storage, adapter);
try {
  await learner.startOrResume(id, plan);
  const state = await learner.wait(id);
  console.log(JSON.stringify({
    trials: state.trials.length,
    accepted: state.trials.filter((t) => t.accepted).length,
    championComponents: state.champion.components,
    history: state.trials.map((t) => ({
      accepted: t.accepted,
      reason: t.reason,
      components: t.candidate.components,
    })),
    executions: state.executions,
  }, null, 2));

  // Held-out on fresh seeds. Never used for selection.
  const HELD_OUT = Array.from({ length: 200 }, (_, i) => 2_000_000 + i);
  const score = (version) => {
    const rs = evaluate(version, HELD_OUT);
    const mean = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    return { mean, wins: rs.filter((r) => r.score === 1).length, losses: rs.filter((r) => r.score === 0).length };
  };
  console.log(JSON.stringify({
    heldOut: HELD_OUT.length,
    champion: score(state.champion),
    initial: score(initialVersion()),
  }, null, 2));
} finally {
  await learner.close();
}
