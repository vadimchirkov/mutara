// Connect Four on a 5x5 board (win = 4). Gravity, small enough for a starter.
// Pure, deterministic given an integer seed, repeatable, cost 0.
export const COLS = 5;
export const ROWS = 5;
export const WIN = 4;

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Board: ROWS*COLS array, row 0 = top. null | 'X' | 'O'.
export const emptyBoard = () => Array(COLS * ROWS).fill(null);
const at = (b, r, c) => b[r * COLS + c];

export function heights(board) {
  const h = Array(COLS).fill(0);
  for (let c = 0; c < COLS; c++) {
    for (let r = ROWS - 1; r >= 0; r--) {
      if (at(board, r, c)) h[c]++;
      else break;
    }
  }
  return h;
}

export const legalMoves = (board) => {
  const h = heights(board);
  const out = [];
  for (let c = 0; c < COLS; c++) if (h[c] < ROWS) out.push(c);
  return out;
};

export function apply(board, col, player) {
  const h = heights(board);
  const next = board.slice();
  next[(ROWS - 1 - h[col]) * COLS + col] = player;
  return next;
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

export function winner(board) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = at(board, r, c);
      if (!p) continue;
      for (const [dr, dc] of DIRS) {
        let n = 1;
        for (let k = 1; k < WIN; k++) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || at(board, rr, cc) !== p) break;
          n++;
        }
        if (n === WIN) return p;
      }
    }
  }
  return null;
}

export const isDraw = (board) => !board.includes(null) && !winner(board);
export const plies = (board) => board.filter(Boolean).length;
