// Kuhn policy-search benchmark. New ID + new DB per run.
// Uses only public exports: mutara/sqlite.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion, HONEST, TRICKY } from "./strategy.mjs";
import { ev, exploitability } from "./game.mjs";

const id = process.argv[2] ?? "kuhn-comp-v1";
const storage = process.argv[3] ?? "./examples/kuhn/learning.db";

const plan = buildPlan({ rounds: 48, seed: 7919, minimumGain: 0.002 });
const learner = learnerHarness(storage, adapter);
try {
  const saved = await learner.state(id);
  if (saved.status === "idle") await learner.start(id, plan);
  const state = await learner.wait(id);
  console.log(JSON.stringify({
    trials: state.trials.length,
    accepted: state.trials.filter((t) => t.accepted).length,
    championPolicy: state.champion.policy,
    history: state.trials.map((t) => ({
      accepted: t.accepted,
      reason: t.reason,
      policy: t.candidate.policy,
    })),
    executions: state.executions,
  }, null, 2));

  // Held-out: exact exploitability (0 = Nash) + EV vs both fixed opponents.
  // Never used for selection.
  const report = (version) => ({
    exploitability: exploitability(version.policy),
    evVsHonest: ev(version.policy, HONEST),
    evVsTricky: ev(version.policy, TRICKY),
  });
  console.log(JSON.stringify({
    champion: report(state.champion),
    initial: report(initialVersion()),
    gameValueP1: -1 / 18, // textbook Kuhn value, for scale
  }, null, 2));
} finally {
  await learner.close();
}
