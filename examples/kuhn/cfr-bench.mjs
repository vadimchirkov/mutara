// CFR through the engine: 300 exact iterations, journaled. The engine caps
// one experiment at 100 rounds, so this is a 3-link supervisor chain — the
// same pattern as ../tictactoe/chain.mjs. Regrets and the average strategy
// live in the version, so the handoff loses nothing. New IDs + new DB.
// Uses only public exports: mutara/sqlite.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildCfrPlan, finalPolicy, initialVersion } from "./cfr.mjs";
import { exploitability, ev } from "./game.mjs";
import { HONEST, TRICKY } from "./strategy.mjs";

const LINKS = 3;
const ROUNDS_PER_LINK = 100;
const storage = process.argv[2] ?? "./examples/kuhn/cfr.db";

const learner = learnerHarness(storage, adapter);
try {
  let initial = initialVersion();
  const links = [];
  for (let i = 1; i <= LINKS; i++) {
    const id = `kuhn-cfr-v1-l${i}`;
    const plan = { ...buildCfrPlan({ rounds: ROUNDS_PER_LINK }), initial };
    await learner.startOrResume(id, plan);
    const state = await learner.wait(id);
    links.push({
      id,
      trials: state.trials.length,
      accepted: state.trials.filter((t) => t.accepted).length,
      iterations: state.champion.iter,
      executions: state.executions,
    });
    initial = state.champion;
  }
  console.log(JSON.stringify({ links }));

  // The Nash approximation is the average strategy, not the last policy.
  const nash = finalPolicy(initial);
  console.log(JSON.stringify({
    nashPolicy: nash.map((p) => Math.round(p * 1000) / 1000),
    exploitability: exploitability(nash),
    evVsHonest: ev(nash, HONEST),
    evVsTricky: ev(nash, TRICKY),
    gameValueP1: -1 / 18,
  }, null, 2));
} finally {
  await learner.close();
}
