// Pong trainer: short links, progress after every link. Writes progress.json
// (learning curve) and champion.json (current components for the viewer) into
// examples/pong/ — the screen polls them. Uses only public exports.
import { writeFileSync } from "node:fs";
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildPlan, evaluate } from "./experiment.mjs";
import { initialVersion } from "./strategy.mjs";

const LINKS = 12;
const ROUNDS_PER_LINK = 4;
const SEEDS_PER_SET = 32;
const storage = process.argv[2] ?? "./examples/pong/learning.db";
const dir = new URL("./", import.meta.url).pathname;

const learner = learnerHarness(storage, adapter);
const history = [];
try {
  let initial = initialVersion();
  for (let i = 1; i <= LINKS; i++) {
    const id = `pong-v1-l${i}`;
    const plan = buildPlan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + i,
      minimumGain: 0.05,
      initial,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 1001 + k),
    });
    await learner.startOrResume(id, plan);
    const state = await learner.wait(id);
    initial = state.champion;
    const accepted = state.trials.filter((t) => t.accepted).length;
    // Fresh-seed estimate of the champion for the curve (never selects).
    const probe = evaluate(initial, [50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008]);
    const mean = probe.reduce((a, r) => a + r.score, 0) / probe.length;
    history.push({ link: i, trials: state.trials.length, accepted, mean, components: initial.components });
    writeFileSync(dir + "progress.json", JSON.stringify({ history }));
    writeFileSync(dir + "champion.json", JSON.stringify({ components: initial.components }));
    console.log(`link ${i}: accepted ${accepted}/${state.trials.length}, probe mean ${mean.toFixed(3)}, components ${JSON.stringify(initial.components.map((c) => c.feature + ":" + c.weight))}`);
  }
} finally {
  await learner.close();
}
