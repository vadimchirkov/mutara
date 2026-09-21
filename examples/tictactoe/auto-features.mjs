// Machine-invented feature dictionary for tic-tac-toe. Written in ONE shot by
// the generator (LLM role), never revised after results — that is the protocol.
// Deliberately excludes the human five (takeWin/blockWin/center/corner/edge):
// the test is invention beyond them, not rediscovery of them.
// Signature matches the human space: (board, move, player) -> 0 | 1, pure.
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
const plies = (b) => b.filter(Boolean).length;
const openFor = (b, p) => LINES.filter((l) => mine(l, b, p) >= 1 && mine(l, b, other(p)) === 0).length;

export const FEATURES = {
  // Two winning threats at once (usually decisive vs short search).
  fork: (board, move, player) => {
    const b = after(board, move, player);
    return LINES.filter((l) => mine(l, b, player) === 2 && open(l, b) === 1).length >= 2 ? 1 : 0;
  },
  // Any immediate threat (pressure, not necessarily the win itself).
  threat: (board, move, player) => {
    const b = after(board, move, player);
    return LINES.some((l) => mine(l, b, player) === 2 && open(l, b) === 1) ? 1 : 0;
  },
  // Classic: take the corner opposite an opponent corner.
  oppositeCorner: (board, move, player) =>
    CORNERS.has(move) && board[8 - move] === other(player) ? 1 : 0,
  // Corner only makes sense once the center is gone.
  cornerWhenCenterTaken: (board, move) =>
    CORNERS.has(move) && board[4] ? 1 : 0,
  // Edge reply to a central opponent.
  edgeWhenOppCenter: (board, move, player) =>
    EDGES.has(move) && board[4] === other(player) ? 1 : 0,
  // Builds or completes a pair (fires on winning moves too, emergently).
  twoInRow: (board, move, player) => {
    const b = after(board, move, player);
    return LINES.some((l) => mine(l, b, player) >= 2) ? 1 : 0;
  },
  // Spoils a line where the opponent started (1 opp, 0 mine, move inside).
  spoil: (board, move, player) => {
    const o = other(player);
    return LINES.some((l) => l.includes(move) && mine(l, board, o) === 1 && mine(l, board, player) === 0) ? 1 : 0;
  },
  // Keeps at least two open lines after the move (stays mobile).
  attackCount: (board, move, player) => (openFor(after(board, move, player), player) >= 2 ? 1 : 0),
  // Leaves the opponent at most one open line (squeeze).
  squeeze: (board, move, player) => (openFor(after(board, move, player), other(player)) <= 1 ? 1 : 0),
  // Holds at least two corners after the move.
  cornerDuo: (board, move, player) =>
    after(board, move, player).filter((v, i) => v === player && CORNERS.has(i)).length >= 2 ? 1 : 0,
  // Holds at least two edges after the move.
  edgeDuo: (board, move, player) =>
    after(board, move, player).filter((v, i) => v === player && EDGES.has(i)).length >= 2 ? 1 : 0,
  // Edge in the early middlegame (positional timing guess).
  tempoEdge: (board, move) => {
    const n = plies(board);
    return EDGES.has(move) && n >= 2 && n <= 4 ? 1 : 0;
  },
  // Never hangs an immediate loss (no opponent 2-threat left behind).
  safeMove: (board, move, player) => {
    const b = after(board, move, player);
    const o = other(player);
    return LINES.every((l) => !(mine(l, b, o) === 2 && open(l, b) === 1)) ? 1 : 0;
  },
  // Takes the center while the opponent camps in a corner.
  centerVsCorner: (board, move, player) =>
    move === 4 && board.some((v, i) => v === other(player) && CORNERS.has(i)) ? 1 : 0,
};
