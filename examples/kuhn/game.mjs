// Kuhn poker: 3 cards (0=J,1=Q,2=K), ante 1, one bet of 1. Zero-sum, X = P1.
// Only 6 deals, so expected value is computed exactly — no sampling noise.
// Pure, deterministic. Policy = 12 numbers in fixed infoset order:
//
//   [0..2]  P1 open:        bet with J,Q,K (else check)
//   [3..5]  P2 after check: bet with J,Q,K (else check)
//   [6..8]  P1 facing bet:  call with J,Q,K (else fold)
//   [9..11] P2 facing bet:  call with J,Q,K (else fold)
export const CARDS = [0, 1, 2];

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const showdown = (c1, c2, pot) => (c1 > c2 ? pot / 2 : -pot / 2); // from P1 view

/** Exact EV for P1 given both seat policies. Enumerates all 6 deals. */
export function ev(p1, p2) {
  let total = 0;
  for (const c1 of CARDS) {
    for (const c2 of CARDS) {
      if (c1 === c2) continue;
      const bet1 = p1[c1]; // P1 opens
      // P1 bets -> P2 folds (P1 +1) or calls (showdown, pot 4).
      const afterBet = (1 - p2[9 + c2]) * 1 + p2[9 + c2] * showdown(c1, c2, 4);
      // P1 checks -> P2 checks (showdown, pot 2) or bets; P1 folds (-1) or calls.
      const afterCheckBet = (1 - p1[6 + c1]) * -1 + p1[6 + c1] * showdown(c1, c2, 4);
      const afterCheck = (1 - p2[3 + c2]) * showdown(c1, c2, 2) + p2[3 + c2] * afterCheckBet;
      total += bet1 * afterBet + (1 - bet1) * afterCheck;
    }
  }
  return total / 6;
}

/** Per-deal EV contributions (6 numbers, deal order fixed) for delta counting. */
export function evPerDeal(p1, p2) {
  const out = [];
  for (const c1 of CARDS) {
    for (const c2 of CARDS) {
      if (c1 === c2) continue;
      const bet1 = p1[c1];
      const afterBet = (1 - p2[9 + c2]) * 1 + p2[9 + c2] * showdown(c1, c2, 4);
      const afterCheckBet = (1 - p1[6 + c1]) * -1 + p1[6 + c1] * showdown(c1, c2, 4);
      const afterCheck = (1 - p2[3 + c2]) * showdown(c1, c2, 2) + p2[3 + c2] * afterCheckBet;
      out.push((bet1 * afterBet + (1 - bet1) * afterCheck) / 6);
    }
  }
  return out;
}

const ALL_PURE = Array.from({ length: 64 }, (_, n) =>
  Array.from({ length: 6 }, (_, i) => (n >> i) & 1));

/** Best-response EV for P1 (as P1) against a fixed P2 seat policy. Exact. */
export function bestResponseP1(p2seat) {
  let best = -Infinity;
  for (const pure of ALL_PURE) {
    const p1 = [...pure.slice(0, 3), 0, 0, 0, ...pure.slice(3), 0, 0, 0];
    const v = ev(p1, p2seat);
    if (v > best) best = v;
  }
  return best;
}

/** Best-response EV for P2 (as P2) against a fixed P1 seat policy, from P1 view. Exact. */
export function bestResponseP2(p1seat) {
  let best = Infinity; // P2 minimizes P1's EV
  for (const pure of ALL_PURE) {
    const p2 = [0, 0, 0, ...pure.slice(0, 3), 0, 0, 0, ...pure.slice(3)];
    const v = ev(p1seat, p2);
    if (v < best) best = v;
  }
  return best;
}

const seatP1 = (policy) => [...policy.slice(0, 3), 0, 0, 0, ...policy.slice(6, 9), 0, 0, 0];
const seatP2 = (policy) => [0, 0, 0, ...policy.slice(3, 6), 0, 0, 0, ...policy.slice(9)];

/** Exploitability of a full (both-seats) policy. 0 = Nash. Exact. */
export function exploitability(policy) {
  return (bestResponseP1(seatP2(policy)) - bestResponseP2(seatP1(policy))) / 2;
}
