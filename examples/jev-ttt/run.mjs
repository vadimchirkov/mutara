// Jev + Mutara: tune tic-tac-toe evaluation strategy via structured judgments.
//
// Inner loop: Jev (or mock) evaluates board positions → picks move.
// Outer loop: Mutara tunes the weights on Jev's Score questions.
//
// TYPESAFE_API_KEY=... node examples/jev-ttt/run.mjs
// Without key: runs in mock mode (local heuristic, same protocol).
import { optimize } from "teob-mutara/optimizer";
import { emptyBoard, winner, isDraw, apply, rng, legalMoves } from "./game.mjs";
import { jevMove, createClient, DEFAULT_STRATEGY, HAS_KEY } from "./jev.mjs";

const other = (p) => (p === "X" ? "O" : "X");

// Fixed opponent: random. Jev agent plays X.
function randomMove(board, rand) {
  const moves = legalMoves(board);
  return moves[Math.floor(rand() * moves.length)];
}

async function playGame(strategy, sample, client) {
  const rand = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let board = emptyBoard();
  let toMove = sample % 2 === 0 ? "X" : "O";
  // ponytail: cap moves at 9 (3x3 can't exceed this)
  for (let ply = 0; ply < 9; ply++) {
    const w = winner(board);
    if (w) return w === "X" ? 1 : 0;
    if (isDraw(board)) return 0.5;
    const move = toMove === "X"
      ? await jevMove(board, "X", strategy, client)
      : randomMove(board, rand);
    board = apply(board, move, toMove);
    toMove = other(toMove);
  }
  const w = winner(board);
  return w === "X" ? 1 : w === "O" ? 0 : 0.5;
}

// Build strategy from optimizer config (weights only; questions stay fixed).
function configToStrategy(config) {
  return {
    questions: DEFAULT_STRATEGY.questions,
    weights: {
      control: Number(config.w_control),
      threat: Number(config.w_threat),
      defense: Number(config.w_defense),
    },
  };
}

const client = createClient();
console.log(HAS_KEY ? "🔑 Jev mode (TypeSafe API)" : "🧪 Mock mode (local heuristic)");

const result = await optimize({
  id: process.argv[2] ?? "jev-ttt-v1",
  storage: process.argv[3] ?? "./examples/jev-ttt/learning.db",
  space: {
    w_control: { type: "float", min: 0, max: 1, initial: 0.3 },
    w_threat:  { type: "float", min: 0, max: 1, initial: 0.5 },
    w_defense: { type: "float", min: 0, max: 1, initial: 0.2 },
  },
  metrics: [{ name: "score", direction: "higher", weight: 1 }],
  implementation: {
    game: "tictactoe-jev-v1",
    mode: HAS_KEY ? "jev" : "mock",
    questions: DEFAULT_STRATEGY.questions,
  },
  execute: async (config, { sample }) => {
    const strategy = configToStrategy(config);
    const score = await playGame(strategy, sample, client);
    // Cost: ~1 Jev call per move for X ≈ 4-5 calls per game.
    // In mock mode cost is 0.
    return { output: { score }, cost: HAS_KEY ? 0.001 : 0 };
  },
  recovery: HAS_KEY ? "idempotent" : "repeatable",
  decision: { mode: "heuristic" },
  budget: { trials: 10, cost: HAS_KEY ? 10 : 0 },
  costLimit: HAS_KEY ? 0.01 : 0,
  samplesPerTrial: HAS_KEY ? 10 : 20, // fewer samples in Jev mode to fit 5min timeout
});

console.log("\n--- Champion ---");
console.log("Weights:", {
  control: result.champion.w_control.toFixed(3),
  threat: result.champion.w_threat.toFixed(3),
  defense: result.champion.w_defense.toFixed(3),
});
console.log("Trials:", result.totalTrials, "| Executions:", result.executions, "| Spent:", result.spent);

// Held-out evaluation on fresh seeds.
const HELD_OUT = 100;
async function evaluate(config) {
  const strategy = configToStrategy(config);
  let sum = 0, wins = 0, draws = 0, losses = 0;
  for (let i = 0; i < HELD_OUT; i++) {
    const s = 1_000_000 + i;
    const score = await playGame(strategy, s, client);
    sum += score;
    if (score === 1) wins++;
    else if (score === 0.5) draws++;
    else losses++;
  }
  return { mean: (sum / HELD_OUT).toFixed(3), wins, draws, losses };
}

console.log("\n--- Held-out (n=" + HELD_OUT + ") ---");
const champResult = await evaluate(result.champion);
const baseResult = await evaluate(DEFAULT_STRATEGY.weights);
console.log("Champion:", champResult);
console.log("Baseline:", baseResult);
