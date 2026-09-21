// Ceiling check: perfect minimax vs learned champion, both colors.
// Pure evaluation, no journal. Tells whether 0.86 is the game's ceiling.
import { emptyBoard, winner, isDraw, apply, legalMoves } from "./game.mjs";
import { rng } from "./game.mjs";
import { mctsMove } from "./mcts.mjs";
import { strategyVersion, versionMove } from "./strategy.mjs";

const memo = new Map();
const key = (b, p) => p + ":" + b.map((v) => v ?? "-").join("");
// Negamax score from `player` perspective: 1 win, 0.5 draw, 0 loss.
function negamax(board, player) {
  const w = winner(board);
  if (w) return w === player ? 1 : 0;
  if (isDraw(board)) return 0.5;
  const k = key(board, player);
  if (memo.has(k)) return memo.get(k);
  let best = -1;
  for (const m of legalMoves(board)) {
    const reply = negamax(apply(board, m, player), player === "X" ? "O" : "X");
    const mine = 1 - reply;
    if (mine > best) best = mine;
    if (best === 1) break;
  }
  memo.set(k, best);
  return best;
}

export function minimaxMove(board, player) {
  let bestMove = legalMoves(board)[0];
  let best = -1;
  for (const m of legalMoves(board)) {
    const reply = negamax(apply(board, m, player), player === "X" ? "O" : "X");
    const mine = 1 - reply;
    if (mine > best) {
      best = mine;
      bestMove = m;
    }
  }
  return bestMove;
}

function play(policyX, policyO, sample) {
  const rx = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const ro = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let board = emptyBoard();
  let toMove = sample % 2 === 0 ? "X" : "O";
  while (true) {
    const w = winner(board);
    if (w) return w === "X" ? 1 : 0;
    if (isDraw(board)) return 0.5;
    const move = toMove === "X" ? policyX(board, "X", rx) : policyO(board, "O", ro);
    board = apply(board, move, toMove);
    toMove = toMove === "X" ? "O" : "X";
  }
}

// Champion-equivalent from ttt-chain (components only matter for the version).
const champion = strategyVersion(
  { uctC: 1.4, simulations: 15 },
  null,
  [
    { feature: "blockWin", weight: 0.5, when: "always" },
    { feature: "center", weight: 1, when: "always" },
    { feature: "takeWin", weight: 2, when: "always" },
  ],
);
const baseline = { uctC: 1.4, simulations: 15 };
const champPolicy = (b, p, r) => versionMove(champion, b, p, r);
const basePolicy = (b, p, r) => mctsMove(b, p, baseline, r);
const perfect = (b, p) => minimaxMove(b, p);

const N = 200;
const seeds = Array.from({ length: N }, (_, i) => 3_000_000 + i);
const score = (px, po) => {
  const rs = seeds.map((s) => play(px, po, s));
  return { mean: rs.reduce((a, x) => a + x, 0) / N, wins: rs.filter((x) => x === 1).length, draws: rs.filter((x) => x === 0.5).length, losses: rs.filter((x) => x === 0).length };
};

console.log(JSON.stringify({
  games: N,
  perfectVsPerfect: score(perfect, perfect),
  championVsPerfect: score(champPolicy, perfect),
  perfectVsChampion: score(perfect, champPolicy),
  baselineVsPerfect: score(basePolicy, perfect),
  perfectVsBaseline: score(perfect, basePolicy),
}, null, 2));
