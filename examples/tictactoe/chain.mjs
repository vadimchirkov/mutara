// Supervisor chain: bounded links, each a new experiment ID.
// Link champion becomes the next link's initial; every link gets fresh seeds
// (reusing one small set across links would overfit it); the final held-out
// never takes part in selection. Killable/restartable: finished links resume
// from journal without re-executing. Uses only public exports: mutara/sqlite.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion } from "./strategy.mjs";

const LINKS = 3;
const ROUNDS_PER_LINK = 6;
const SEEDS_PER_SET = 48;
const storage = process.argv[2] ?? "./examples/tictactoe/chain.db";

const learner = learnerHarness(storage, adapter);
try {
  let initial = initialVersion();
  const links = [];
  for (let i = 1; i <= LINKS; i++) {
    const id = `ttt-chain-l${i}`;
    const plan = buildPlan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + i,
      minimumGain: 0.02,
      initial,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 1001 + k),
    });
    await learner.startOrResume(id, plan);
    const state = await learner.wait(id);
    links.push({
      id,
      trials: state.trials.length,
      accepted: state.trials.filter((t) => t.accepted).length,
      championComponents: state.champion.components,
      executions: state.executions,
    });
    initial = state.champion; // handoff: lineage continues via parentId chain
  }
  console.log(JSON.stringify({ links }, null, 2));

  const HELD_OUT = Array.from({ length: 200 }, (_, i) => 9_000_000 + i);
  const score = (version) => {
    const rs = evaluate(version, HELD_OUT);
    const mean = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    return { mean, wins: rs.filter((r) => r.score === 1).length, draws: rs.filter((r) => r.score === 0.5).length, losses: rs.filter((r) => r.score === 0).length };
  };
  console.log(JSON.stringify({
    heldOut: HELD_OUT.length,
    final: score(initial),
    original: score(initialVersion()),
  }, null, 2));
} finally {
  await learner.close();
}
