// Round-2 refinements: feedback-driven, one shot, pinned unrevised.
// Feedback was the paired held-out gap (machine 0.695 vs human 0.8325):
// traces show the machine ceding the center and missing clean wins/blocks.
// Unlike v1, surgical atoms are ALLOWED here — if selection rediscovers
// takeWin/center from feedback, that IS the finding (the loop converges),
// not cheating. v1 proved novelty-without-parity; v2 tests convergence.
import { FEATURES as V1 } from "./auto-features.mjs";

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const CORNERS = new Set([0, 2, 6, 8]);
const EDGES = new Set([1, 3, 5, 7]);
const other = (p) => (p === "X" ? "O" : "X");
const after = (board, move, player) => {
  const b = board.slice();
  b[move] = player;
  return b;
};
const mine = (line, b, p) => line.filter((i) => b[i] === p).length;
const open = (line, b) => line.filter((i) => !b[i]).length;

const V2 = {
  // Completes three (surgical win-taking, reinvented from the miss pattern).
  completesWin: (board, move, player) => {
    const b = after(board, move, player);
    return LINES.some((l) => mine(l, b, player) === 3) ? 1 : 0;
  },
  // Sits in an opponent two-threat (surgical block, reinvented).
  stopsWin: (board, move, player) => {
    const o = other(player);
    return LINES.some((l) => l.includes(move) && mine(l, board, o) === 2 && open(l, board) === 1) ? 1 : 0;
  },
  // Takes the free center (surgical center-seeking, reinvented).
  freeCenter: (board, move) => (move === 4 && !board[4] ? 1 : 0),
  // Answers a central opponent with any corner.
  cornerReply: (board, move, player) =>
    CORNERS.has(move) && board[4] === other(player) ? 1 : 0,
  // Answers corner campers with an edge (anti-fork shape).
  edgeReply: (board, move, player) =>
    EDGES.has(move) && board.some((v, i) => v === other(player) && CORNERS.has(i)) ? 1 : 0,
  // Win or threat in one (broader decisive atom).
  winOrThreat: (board, move, player) => {
    const b = after(board, move, player);
    return LINES.some((l) => mine(l, b, player) === 3 || (mine(l, b, player) === 2 && open(l, b) === 1)) ? 1 : 0;
  },
  // Center only once the opening is over (timing variant).
  lateCenter: (board, move) => (move === 4 && board.filter(Boolean).length >= 4 ? 1 : 0),
  // Either decisive action: complete mine or sit in theirs.
  blockOrWin: (board, move, player) => {
    const o = other(player);
    const b = after(board, move, player);
    return LINES.some((l) => mine(l, b, player) === 3) ||
      LINES.some((l) => l.includes(move) && mine(l, board, o) === 2 && open(l, board) === 1) ? 1 : 0;
  },
};

export const FEATURES = { ...V1, ...V2 };
export const V2_NAMES = Object.keys(V2);
