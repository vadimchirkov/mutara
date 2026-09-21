// Step zero: what does a game cost? Heuristic vs heuristic, no learning.
// Reports frames/game distribution, physics steps/sec, ms/game — the number
// the whole training budget divides by.
import { initialState, step, isTerminal, winner, serve, COURT } from "./game.mjs";
import { rng } from "./game.mjs";

// Track the ball with a deadband; blind when it moves away.
const heuristic = (state, me) => {
  const paddle = me === "X" ? state.paddleX : state.paddleO;
  const toward = me === "X" ? state.ball.vx < 0 : state.ball.vx > 0;
  if (!toward) return 0;
  const dy = state.ball.y - paddle;
  if (Math.abs(dy) < 1.5) return 0;
  return dy > 0 ? 1 : -1;
};

const N = Number(process.argv[2] ?? 200);
const FRAME_SKIP = 4; // policy decides every 4th frame, action repeats
let frames = 0;
let decisions = 0;
const t0 = Date.now();
const results = [];
for (let g = 0; g < N; g++) {
  const rand = rng(5000 + g);
  let s = initialState(rand);
  let ax = 0;
  let ao = 0;
  let f = 0;
  for (; f < 20000; f++) {
    if (f % FRAME_SKIP === 0) {
      ax = heuristic(s, "X");
      ao = heuristic(s, "O");
      decisions++;
    }
    s = step(s, ax, ao);
    if (s.scored) s = serve(s, rand);
    if (isTerminal(s)) break;
  }
  frames += f;
  results.push({ frames: f, winner: winner(s), scoreX: s.scoreX, scoreO: s.scoreO });
}
const ms = Date.now() - t0;
const wins = results.filter((r) => r.winner === "X").length;
const meanFrames = frames / N;
console.log(JSON.stringify({
  games: N,
  frameSkip: FRAME_SKIP,
  target: 5,
  xWins: wins,
  meanFrames: Math.round(meanFrames),
  decisionsPerGame: Math.round(decisions / N),
  stepsPerSec: Math.round((frames / ms) * 1000),
  msPerGame: ms / N,
  wallMs: ms,
}, null, 2));
