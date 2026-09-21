// Pong physics: pure, deterministic, zero assets. Units are abstract.
// X = left paddle (version policy), O = right paddle (opponent).
// All randomness (serves) comes from the caller-provided rng.
export const COURT = { w: 100, h: 60 };
export const PADDLE_H = 12;
export const PADDLE_SPEED = 1.0;
export const BALL_SPEED = 1.2;
export const TARGET = 5; // first to TARGET points wins

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// State: { ball: {x,y,vx,vy}, paddleX, paddleO (center-y), scoreX, scoreO }.
export function serve(state, rand) {
  const dir = rand() < 0.5 ? 1 : -1;
  const angle = (rand() - 0.5) * 1.2; // radians-ish spread
  const vx = dir * BALL_SPEED * Math.cos(angle);
  const vy = BALL_SPEED * Math.sin(angle);
  return { ...state, ball: { x: COURT.w / 2, y: COURT.h / 2, vx, vy } };
}

export const initialState = (rand) => serve({
  ball: { x: 0, y: 0, vx: 0, vy: 0 },
  paddleX: COURT.h / 2,
  paddleO: COURT.h / 2,
  scoreX: 0,
  scoreO: 0,
}, rand);

const clampPaddle = (y) => Math.max(PADDLE_H / 2, Math.min(COURT.h - PADDLE_H / 2, y));

// Actions: -1 (up), 0 (stay), +1 (down). Returns next state (fresh object).
export function step(state, ax, ao) {
  let { ball, paddleX, paddleO, scoreX, scoreO } = state;
  paddleX = clampPaddle(paddleX + ax * PADDLE_SPEED);
  paddleO = clampPaddle(paddleO + ao * PADDLE_SPEED);
  let { x, y, vx, vy } = ball;
  x += vx;
  y += vy;
  if (y < 0) {
    y = -y;
    vy = -vy;
  } else if (y > COURT.h) {
    y = 2 * COURT.h - y;
    vy = -vy;
  }
  // Left paddle (face at x=2).
  if (vx < 0 && x <= 3 && x >= 0 && Math.abs(y - paddleX) <= PADDLE_H / 2 + 1) {
    const offset = (y - paddleX) / (PADDLE_H / 2); // -1..1
    const speed = Math.min(2.6, Math.hypot(vx, vy) * 1.05);
    const ang = Math.max(-1.1, Math.min(1.1, offset * 0.9));
    vx = speed * Math.cos(ang);
    vy = speed * Math.sin(ang);
    x = 3;
  }
  // Right paddle (face at x=97).
  if (vx > 0 && x >= 97 && x <= 100 && Math.abs(y - paddleO) <= PADDLE_H / 2 + 1) {
    const offset = (y - paddleO) / (PADDLE_H / 2);
    const speed = Math.min(2.6, Math.hypot(vx, vy) * 1.05);
    const ang = Math.max(-1.1, Math.min(1.1, offset * 0.9));
    vx = -speed * Math.cos(ang);
    vy = speed * Math.sin(ang);
    x = 97;
  }
  let scored = null;
  if (x < 0) {
    scoreO += 1;
    scored = "O";
  } else if (x > COURT.w) {
    scoreX += 1;
    scored = "X";
  }
  return { ball: { x, y, vx, vy }, paddleX, paddleO, scoreX, scoreO, scored };
}

export const isTerminal = (state) => state.scoreX >= TARGET || state.scoreO >= TARGET;
export const winner = (state) => {
  if (state.scoreX >= TARGET) return "X";
  if (state.scoreO >= TARGET) return "O";
  return null;
};
export const legalMoves = () => [-1, 0, 1];
