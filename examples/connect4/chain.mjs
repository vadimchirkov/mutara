// Supervisor chain for Connect-4. Same pattern as ../tictactoe/chain.mjs:
// new ID + fresh seeds per link, champion handoff, resume from journal.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion } from "./strategy.mjs";

const LINKS = 3;
const ROUNDS_PER_LINK = 6;
const SEEDS_PER_SET = 64;
const storage = process.argv[2] ?? "./examples/connect4/chain.db";

const learner = learnerHarness(storage, adapter);
try {
  let initial = initialVersion();
  const links = [];
  for (let i = 1; i <= LINKS; i++) {
    const id = `c4-chain-l${i}`;
    const plan = buildPlan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + i,
      minimumGain: 0.02,
      initial,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 1001 + k),
    });
    const saved = await learner.state(id);
    if (saved.status === "idle") await learner.start(id, plan);
    const state = await learner.wait(id);
    links.push({
      id,
      trials: state.trials.length,
      accepted: state.trials.filter((t) => t.accepted).length,
      championComponents: state.champion.components,
      executions: state.executions,
    });
    initial = state.champion;
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
