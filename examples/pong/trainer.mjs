// Pong trainer: short links, progress after every link. Writes progress.json
// (learning curve) and champion.json (current components for the viewer) into
// examples/pong/ — the screen polls them. Uses only public exports.
// argv: [storage] [baseline=deadband|predictive]. A new baseline retires old
// IDs (different experiment); strategy.mjs edits likewise retired v1 journals.
import { writeFileSync } from "node:fs";
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion, strategyVersion, PREDICTIVE } from "./strategy.mjs";

const LINKS = 12;
const ROUNDS_PER_LINK = 4;
const SEEDS_PER_SET = 32;
const storage = process.argv[2] ?? "./examples/pong/learning.db";
const baselineName = process.argv[3] ?? "deadband";
const baseline = baselineName === "predictive" ? PREDICTIVE : "deadband";
const tag = baselineName === "predictive" ? "pong-v2" : "pong-v1";
const dir = new URL("./", import.meta.url).pathname;

// Handoff by reconstruction: the v1 champion, rebuilt under the current
// implementation hash (strategy.mjs edits retire old version ids).
const V1 = () => strategyVersion([
  { feature: "intercept", weight: 0.5, when: "always" },
  { feature: "retreatCenter", weight: 1, when: "always" },
  { feature: "trackBall", weight: 0.25, when: "always" },
], null);

const learner = learnerHarness(storage, adapter);
const history = [];
try {
  let initial = baselineName === "predictive" ? V1() : initialVersion();
  for (let i = 1; i <= LINKS; i++) {
    const id = `${tag}-l${i}`;
    const plan = buildPlan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + i,
      minimumGain: 0.05,
      initial,
      baseline,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 1001 + k),
    });
    await learner.startOrResume(id, plan);
    const state = await learner.wait(id);
    initial = state.champion;
    const accepted = state.trials.filter((t) => t.accepted).length;
    // Fresh-seed estimate of the champion for the curve (never selects).
    const probe = evaluate(initial, [50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008], baseline);
    const mean = probe.reduce((a, r) => a + r.score, 0) / probe.length;
    history.push({ link: i, trials: state.trials.length, accepted, mean, components: initial.components });
    writeFileSync(dir + "progress.json", JSON.stringify({ history, baseline: baselineName }));
    writeFileSync(dir + "champion.json", JSON.stringify({ components: initial.components }));
    console.log(`link ${i}: accepted ${accepted}/${state.trials.length}, probe mean ${mean.toFixed(3)}, components ${JSON.stringify(initial.components.map((c) => c.feature + ":" + c.weight))}`);
  }
} finally {
  await learner.close();
}
