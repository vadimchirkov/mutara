// Starter: tune MCTS params for tic-tac-toe via the declarative optimizer.
// No core changes. Uses only public exports: mutara/optimizer.
// Sequential gate: promotions carry a confidence claim; held-out below still reports.
// Shared logic lives in tuning.mjs (importable by the smoke test).
import { optimize } from "teob-mutara/optimizer";
import { playGame, execute, implementation, space, BASELINE } from "./tuning.mjs";

const id = process.argv[2] ?? "ttt-seq-v1";
const storage = process.argv[3] ?? "./examples/tictactoe/learning.db";

const result = await optimize({
  id,
  storage,
  space,
  metrics: [{ name: "score", direction: "higher", weight: 1, bounds: { min: 0, max: 1 } }],
  implementation: { execute: execute.toString(), ...implementation },
  execute,
  recovery: "repeatable", // safe local sim, no paid/visible effects
  decision: { mode: "sequential" }, // anytime-valid gate; stops each trial once evidence is decisive
  budget: { trials: 15 },
  samplesPerTrial: 200, // cap per trial; sequential stops most trials far earlier
});

console.log(JSON.stringify({ champion: result.champion, trials: result.totalTrials, executions: result.executions }, null, 2));

// Separate held-out check on fresh seeds. Never used for selection.
const HELD_OUT = 200;
const tally = (config) => {
  let sum = 0, wins = 0, draws = 0, losses = 0;
  for (let i = 0; i < HELD_OUT; i++) {
    const s = 1_000_000 + i;
    const score = playGame(config, s);
    sum += score;
    if (score === 1) wins++;
    else if (score === 0.5) draws++;
    else losses++;
  }
  return { mean: sum / HELD_OUT, wins, draws, losses };
};
const champ = tally(result.champion);
const base = tally(BASELINE);
console.log(JSON.stringify({ heldOut: HELD_OUT, champion: champ, baseline: base }, null, 2));
