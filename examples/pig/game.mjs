// Pig (push-your-luck dice) to TARGET points. Small stochastic starter:
// decisions under chance, no draws. Pure, deterministic given a seed.
export const TARGET = 20;

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// State: banked scores a (X) / b (O), running turn total, side to act.
export const initialState = () => ({ a: 0, b: 0, turn: 0, toMove: "X" });
export const legalMoves = () => ["roll", "hold"];

// Roll needs a die (1..6); hold ignores it. Bust (1) banks nothing.
export function apply(state, action, die = 1) {
  const next = state.toMove === "X" ? "O" : "X";
  if (action === "hold") {
    const s = { ...state, turn: 0, toMove: next };
    if (state.toMove === "X") s.a += state.turn;
    else s.b += state.turn;
    return s;
  }
  if (die === 1) return { ...state, turn: 0, toMove: next };
  return { ...state, turn: state.turn + die };
}

export function winner(state) {
  if (state.a >= TARGET) return "X";
  if (state.b >= TARGET) return "O";
  return null;
}
