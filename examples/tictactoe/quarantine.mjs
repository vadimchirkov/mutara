// Quarantine for machine-invented features: offline, runs ONCE before the
// dictionary is pinned. Rejects non-deterministic, throwing, non-numeric, or
// slow features. Result recorded in README; failures never reach selection.
import { FEATURES } from "./auto-features.mjs";
import { emptyBoard, legalMoves, apply, rng } from "./game.mjs";

const rand = rng(1234567);
const cases = [];
// Random legal positions, all moves, both players.
for (let g = 0; g < 300; g++) {
  let board = emptyBoard();
  let toMove = "X";
  const plies = Math.floor(rand() * 9);
  for (let p = 0; p < plies; p++) {
    const moves = legalMoves(board);
    if (!moves.length) break;
    board = apply(board, moves[Math.floor(rand() * moves.length)], toMove);
    toMove = toMove === "X" ? "O" : "X";
  }
  for (const move of legalMoves(board)) {
    cases.push([board, move, "X"], [board, move, "O"]);
  }
}
// Edges: empty board, near-full boards.
cases.push([emptyBoard(), 4, "X"], [emptyBoard(), 0, "O"]);
const full = ["X", "O", "X", "O", "X", "O", "X", "O", "X"];
cases.push([full, 0, "X"]);

const report = {};
let failed = 0;
const t0 = Date.now();
for (const [name, fn] of Object.entries(FEATURES)) {
  const problems = [];
  try {
    for (const [board, move, player] of cases) {
      const a = fn(board, move, player);
      const b = fn(board, move, player);
      if (typeof a !== "number" || !Number.isFinite(a) || a < 0 || a > 1) {
        problems.push(`non-binary output ${a}`);
        break;
      }
      if (a !== b) {
        problems.push("non-deterministic");
        break;
      }
    }
  } catch (e) {
    problems.push(`throws: ${e.message}`);
  }
  report[name] = problems.length ? { status: "REJECTED", problems } : { status: "PASS" };
  if (problems.length) failed++;
}
report.elapsedMs = Date.now() - t0;
report.cases = cases.length;
console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
