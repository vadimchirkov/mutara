// Tunable MCTS-vs-MCTS wiring for tic-tac-toe. Importable, no side effects:
// run.mjs is the CLI wrapper, the smoke test imports this module directly.
import { readFileSync } from "node:fs";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";
import { mctsMove } from "./mcts.mjs";

const other = (p) => (p === "X" ? "O" : "X");

// Fixed opponent = initial config. Tuning must beat the starting point itself,
// not a weak random that every candidate already beats ~0.9 (noise-only signal).
export const BASELINE = { uctC: 1.4, simulations: 50 };

/** One paired case. sample -> pinned position: starter + two independent rng streams.
 *  MCTS rollouts and opponent draws use separate streams, so a candidate that
 *  consumes more randomness does not shift the opponent's dice. No modulo recycling. */
export function playGame(config, sample, opponent = BASELINE) {
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

export const execute = async (config, { sample }) => ({
  output: { score: playGame(config, sample) },
  cost: 0,
});

// Pin behavior artifacts, not just a label. Function text alone is not enough
// for real tasks (closures/services/datasets stay outside the hash).
export const implementation = {
  game: "tictactoe-v2",
  rules: "3x3, X=mcts-tuned, O=mcts-fixed-baseline, alternating starter by sample parity, split rng streams",
  opponent: "mcts-uctC1.4-sims50",
  files: {
    "game.mjs": readFileSync(new URL("./game.mjs", import.meta.url), "utf8"),
    "mcts.mjs": readFileSync(new URL("./mcts.mjs", import.meta.url), "utf8"),
    "tuning.mjs": readFileSync(new URL("./tuning.mjs", import.meta.url), "utf8"),
  },
};

export const space = {
  uctC: { type: "float", min: 0, max: 3, initial: 1.4 },
  simulations: { type: "int", min: 10, max: 200, initial: 50 },
};
