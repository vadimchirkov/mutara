// Pure 3x3 tic-tac-toe. Copied from tictactoe/game.mjs — no changes.
export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const emptyBoard = () => Array(9).fill(null);

export function winner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

export const isDraw = (board) => !board.includes(null) && !winner(board);
export const isTerminal = (board) => Boolean(winner(board)) || isDraw(board);
export const legalMoves = (board) => {
  const out = [];
  for (let i = 0; i < 9; i++) if (!board[i]) out.push(i);
  return out;
};

export function apply(board, move, player) {
  const next = board.slice();
  next[move] = player;
  return next;
}

export function randomMove(board, rand) {
  const moves = legalMoves(board);
  return moves[Math.floor(rand() * moves.length)];
}

/** Format board for Jev: 3x3 grid with X, O, and position numbers for empty. */
export function formatBoard(board) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const cells = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      cells.push(board[i] ?? String(i));
    }
    rows.push(cells.join(" | "));
  }
  return rows.join("\n---------\n");
}
