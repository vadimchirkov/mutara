// Minimal UCT agent. Sync, CPU-only, deterministic given `rand`.
// Tunable config is finite JSON: { uctC: float, simulations: int }.
// This file is behavior code; its text is pinned in run.mjs `implementation`.
import { legalMoves, apply, winner, isDraw } from "./game.mjs";

const other = (p) => (p === "X" ? "O" : "X");

function rollout(board, toMove, root, rand) {
  let b = board.slice();
  let t = toMove;
  for (let d = 0; d < 32; d++) {
    const w = winner(b);
    if (w) return w === root ? 1 : 0;
    if (isDraw(b)) return 0.5;
    const moves = legalMoves(b);
    b = apply(b, moves[Math.floor(rand() * moves.length)], t);
    t = other(t);
  }
  return 0.5;
}

export function mctsMove(board, player, config, rand) {
  const moves = legalMoves(board);
  if (moves.length <= 1) return moves[0];
  const uctC = Number(config.uctC);
  const simulations = Math.floor(Number(config.simulations));
  // One node per legal root move is enough for 3x3 at starter budgets.
  const stats = new Map(moves.map((m) => [m, { visits: 0, wins: 0 }]));
  for (let s = 0; s < simulations; s++) {
    // Select: UCB1, unvisited first (fixed order => reproducible).
    let move = moves.find((m) => stats.get(m).visits === 0);
    if (move === undefined) {
      const total = moves.reduce((n, m) => n + stats.get(m).visits, 0);
      let best = -Infinity;
      move = moves[0];
      for (const m of moves) {
        const st = stats.get(m);
        const ucb = st.wins / st.visits + uctC * Math.sqrt(Math.log(total) / st.visits);
        if (ucb > best) {
          best = ucb;
          move = m;
        }
      }
    }
    const score = rollout(apply(board, move, player), other(player), player, rand);
    const st = stats.get(move);
    st.visits += 1;
    st.wins += score;
  }
  let bestMove = moves[0];
  let bestVisits = -1;
  for (const m of moves) {
    if (stats.get(m).visits > bestVisits) {
      bestVisits = stats.get(m).visits;
      bestMove = m;
    }
  }
  return bestMove;
}
