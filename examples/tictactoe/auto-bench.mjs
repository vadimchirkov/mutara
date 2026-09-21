// Machine-dictionary benchmark. New ID + new DB. Uses only public exports.
// Held-out reuses the human run's 200 seeds (2_000_000+i): valid (held-out
// never selects) and paired — machine vs human move by move.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildAutoPlan, evaluate, initialVersion } from "./auto.mjs";
import { evaluate as evaluateHuman } from "./experiment.mjs";
import { strategyVersion as humanVersion, INITIAL_PARAMS } from "./strategy.mjs";

const id = process.argv[2] ?? "ttt-auto-v1";
const storage = process.argv[3] ?? "./examples/tictactoe/auto.db";

const plan = buildAutoPlan();
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

  const HELD_OUT = Array.from({ length: 200 }, (_, i) => 2_000_000 + i);
  const score = (fn, version) => {
    const rs = fn(version, HELD_OUT);
    const mean = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    return { mean, wins: rs.filter((r) => r.score === 1).length, draws: rs.filter((r) => r.score === 0.5).length, losses: rs.filter((r) => r.score === 0).length };
  };
  const machine = score(evaluate, state.champion);
  const machineInit = score(evaluate, initialVersion());
  const humanChamp = humanVersion(INITIAL_PARAMS, null, [
    { feature: "center", weight: 2, when: "always" },
    { feature: "takeWin", weight: 0.5, when: "always" },
  ]);
  const human = score(evaluateHuman, humanChamp);
  const paired = HELD_OUT.map((s, i) => {
    const m = evaluate(state.champion, [s])[0].score;
    const h = evaluateHuman(humanChamp, [s])[0].score;
    return m - h;
  });
  console.log(JSON.stringify({
    heldOut: HELD_OUT.length,
    machine,
    machineInit,
    human,
    pairedMean: paired.reduce((a, b) => a + b, 0) / paired.length,
  }, null, 2));
} finally {
  await learner.close();
}
