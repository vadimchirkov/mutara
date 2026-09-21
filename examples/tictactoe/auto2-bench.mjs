// Round 2: feedback-driven refinements. New ID + new DB.
// Pre-registered bet: paired held-out gap vs the human champion within ±0.03
// (v1: -0.1375). Held-out: the same 200 seeds; paired vs human AND vs v1.
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, buildAutoPlan, evaluate, v1Champion } from "./auto2.mjs";
import { evaluate as evaluateHuman } from "./experiment.mjs";
import { strategyVersion as humanVersion, INITIAL_PARAMS } from "./strategy.mjs";
import { evaluate as evaluateV1 } from "./auto.mjs";
import { strategyVersion as v1Version } from "./auto.mjs";
import { INITIAL_PARAMS as P } from "./auto.mjs";

const id = process.argv[2] ?? "ttt-auto-v2";
const storage = process.argv[3] ?? "./examples/tictactoe/auto2.db";

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
  const humanChamp = humanVersion(INITIAL_PARAMS, null, [
    { feature: "center", weight: 2, when: "always" },
    { feature: "takeWin", weight: 0.5, when: "always" },
  ]);
  const human = score(evaluateHuman, humanChamp);
  const v1 = score(evaluateV1, v1Version(P, null, [
    { feature: "twoInRow", weight: 0.5, when: "always" },
    { feature: "safeMove", weight: 0.5, when: "always" },
    { feature: "centerVsCorner", weight: 0.5, when: "always" },
  ]));
  const pairedVsHuman = HELD_OUT.map((s) => evaluate(state.champion, [s])[0].score - evaluateHuman(humanChamp, [s])[0].score);
  console.log(JSON.stringify({
    heldOut: HELD_OUT.length,
    machine,
    human,
    v1,
    pairedVsHuman: pairedVsHuman.reduce((a, b) => a + b, 0) / pairedVsHuman.length,
  }, null, 2));
} finally {
  await learner.close();
}
