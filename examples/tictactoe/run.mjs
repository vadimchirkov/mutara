// Starter: tune MCTS params for tic-tac-toe via the declarative optimizer.
// No core changes. Uses only public exports: mutara/optimizer.
// Wiring demo (heuristic), not proof of strength — see README.
import { readFileSync } from "node:fs";
import { optimize } from "mutara/optimizer";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";
import { mctsMove } from "./mcts.mjs";

const other = (p) => (p === "X" ? "O" : "X");

// Fixed opponent = initial config. Tuning must beat the starting point itself,
// not a weak random that every candidate already beats ~0.9 (noise-only signal).
const BASELINE = { uctC: 1.4, simulations: 50 };

/** One paired case. sample -> pinned position: starter + two independent rng streams.
 *  MCTS rollouts and opponent draws use separate streams, so a candidate that
 *  consumes more randomness does not shift the opponent's dice. No modulo recycling. */
function playGame(config, sample, opponent = BASELINE) {
  const randMcts = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randOpp = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let board = emptyBoard();
  let toMove = sample % 2 === 0 ? "X" : "O"; // X = tuned MCTS, O = fixed-baseline MCTS
  while (true) {
    const w = winner(board);
    if (w) return w === "X" ? 1 : 0;
    if (isDraw(board)) return 0.5;
    const move = toMove === "X"
      ? mctsMove(board, "X", config, randMcts)
      : mctsMove(board, "O", opponent, randOpp);
    board = apply(board, move, toMove);
    toMove = other(toMove);
  }
}

const execute = async (config, { sample }) => ({
  output: { score: playGame(config, sample) },
  cost: 0,
});

// Pin behavior artifacts, not just a label. Function text alone is not enough
// for real tasks (closures/services/datasets stay outside the hash).
const implementation = {
  game: "tictactoe-v2",
  rules: "3x3, X=mcts-tuned, O=mcts-fixed-baseline, alternating starter by sample parity, split rng streams",
  opponent: "mcts-uctC1.4-sims50",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "mcts.mjs": readFileSync(new URL("./mcts.mjs", import.meta.url), "utf8"),
    "run.mjs": readFileSync(new URL(import.meta.url), "utf8"),
  },
};

const id = process.argv[2] ?? "ttt-mcts-v1";
const storage = process.argv[3] ?? "./examples/tictactoe/learning.db";

const result = await optimize({
  id,
  storage,
  space: {
    uctC: { type: "float", min: 0, max: 3, initial: 1.4 },
    simulations: { type: "int", min: 10, max: 200, initial: 50 },
  },
  metrics: [{ name: "score", direction: "higher", weight: 1 }],
  implementation: { execute: execute.toString(), ...implementation },
  execute,
  recovery: "repeatable", // safe local sim, no paid/visible effects
  decision: { mode: "heuristic" }, // wiring + selection; final word is the held-out below
  budget: { trials: 15 },
  samplesPerTrial: 8, // 15 trials * 8 cases * 2 (baseline+candidate) = 240 games
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
