// Jev integration: evaluate board positions and pick moves via TypeSafe System One.
// Set TYPESAFE_API_KEY in env. Falls back to a local heuristic mock when unset.
import { legalMoves, apply, winner, formatBoard } from "./game.mjs";

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
let TypeSafeClient, score;

if (HAS_KEY) {
  const sdk = await import("@typesafe-ai/sdk");
  TypeSafeClient = sdk.TypeSafeClient;
  score = sdk.score;
}

// ---------------------------------------------------------------------------
// Strategy = a set of Score questions + weights. This is what Mutara tunes.
// ---------------------------------------------------------------------------

/** Default strategy: three evaluation dimensions with weights. */
export const DEFAULT_STRATEGY = {
  questions: {
    control: {
      instructions: "How much does player `player` control the board?",
      criteria: [
        "Opponent dominates; player has no useful positions",
        "Roughly equal; both sides have threats or development",
        "Player dominates; multiple paths toward winning",
      ],
    },
    threat: {
      instructions: "How immediate is a winning threat for player `player`?",
      criteria: [
        "No threat within two moves",
        "Can win in two moves if opponent misplays",
        "Can win on the very next move",
      ],
    },
    defense: {
      instructions: "How urgent is it for player `player` to block the opponent right now?",
      criteria: [
        "Opponent has no immediate threat",
        "Opponent could set up a fork or double-threat soon",
        "Opponent wins next move unless blocked",
      ],
    },
  },
  weights: { control: 0.3, threat: 0.5, defense: 0.2 },
};

// ---------------------------------------------------------------------------
// Jev evaluator: score a board position from a player's perspective.
// ---------------------------------------------------------------------------

/** Call Jev to evaluate a single board state. Returns a composite score 0–1. */
async function jevEval(board, player, strategy, client) {
  const state = {
    board: formatBoard(board),
    player,
    opponent: player === "X" ? "O" : "X",
  };

  const questions = {};
  for (const [key, q] of Object.entries(strategy.questions)) {
    questions[key] = score(q.instructions, q.criteria);
  }

  const response = await client.systemOne({ state, questions });
  const answers = response.answers;

  // Composite: weighted sum of normalized scores.
  let total = 0;
  let wSum = 0;
  for (const [key, w] of Object.entries(strategy.weights)) {
    if (!answers[key]) continue;
    const maxLevel = strategy.questions[key].criteria.length - 1;
    total += w * (answers[key].score / maxLevel);
    wSum += w;
  }
  return wSum > 0 ? total / wSum : 0.5;
}

// ---------------------------------------------------------------------------
// Mock evaluator: local heuristic, same interface. For testing without API key.
// ---------------------------------------------------------------------------

const CORNERS = new Set([0, 2, 6, 8]);
const WIN = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

function mockEval(board, player, strategy) {
  const opp = player === "X" ? "O" : "X";
  const moves = legalMoves(board);

  // Simulate what Jev would return for each dimension.
  const dims = {};

  // Control: count lines still open for each player.
  const myOpen = WIN.filter((l) => l.every((i) => board[i] !== opp)).length;
  const oppOpen = WIN.filter((l) => l.every((i) => board[i] !== player)).length;
  dims.control = myOpen > oppOpen ? 0.8 : myOpen === oppOpen ? 0.5 : 0.2;

  // Threat: can we win soon?
  const canWinNow = WIN.some((l) => {
    const mine = l.filter((i) => board[i] === player).length;
    const empty = l.filter((i) => !board[i]).length;
    return mine === 2 && empty === 1;
  });
  const canWinTwo = WIN.some((l) => {
    const mine = l.filter((i) => board[i] === player).length;
    const empty = l.filter((i) => !board[i]).length;
    return mine === 1 && empty === 2;
  });
  dims.threat = canWinNow ? 1.0 : canWinTwo ? 0.5 : 0.0;

  // Defense: must we block?
  const mustBlock = WIN.some((l) => {
    const theirs = l.filter((i) => board[i] === opp).length;
    const empty = l.filter((i) => !board[i]).length;
    return theirs === 2 && empty === 1;
  });
  const couldFork = WIN.filter((l) => {
    const theirs = l.filter((i) => board[i] === opp).length;
    const empty = l.filter((i) => !board[i]).length;
    return theirs === 1 && empty === 2;
  }).length >= 2;
  dims.defense = mustBlock ? 1.0 : couldFork ? 0.5 : 0.0;

  // Composite with strategy weights.
  let total = 0, wSum = 0;
  for (const [key, w] of Object.entries(strategy.weights)) {
    if (dims[key] !== undefined) { total += w * dims[key]; wSum += w; }
  }
  return wSum > 0 ? total / wSum : 0.5;
}

// ---------------------------------------------------------------------------
// Move selection: evaluate each legal move, pick best.
// ---------------------------------------------------------------------------

/** Pick best move by evaluating each successor state with Jev (or mock). */
export async function jevMove(board, player, strategy, client) {
  const moves = legalMoves(board);
  if (moves.length <= 1) return moves[0];

  // Immediate win.
  for (const m of moves) {
    if (winner(apply(board, m, player)) === player) return m;
  }

  const scores = await Promise.all(
    moves.map(async (m) => {
      const next = apply(board, m, player);
      const v = client
        ? await jevEval(next, player, strategy, client)
        : mockEval(next, player, strategy);
      return { move: m, value: v };
    })
  );

  scores.sort((a, b) => b.value - a.value);
  return scores[0].move;
}

/** Create a Jev client if API key is set; null for mock mode. */
export function createClient() {
  if (!HAS_KEY) return null;
  return new TypeSafeClient();
}

export { HAS_KEY };
