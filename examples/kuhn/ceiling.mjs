// Ceiling: vanilla CFR (deterministic, alternating updates) approximates Nash,
// then exact exploitability of CFR vs champion side by side. Pure, no journal.
import { ev, exploitability } from "./game.mjs";
import { policyVersion } from "./strategy.mjs";

// Infosets in policy-dim order: P1 open (card), P2 after check (card),
// P1 facing bet (card), P2 facing bet (card). Two actions each:
// index 0 = passive (check/fold), 1 = aggressive (bet/call).
function cfr(iterations) {
  const regret = Array.from({ length: 12 }, () => [0, 0]);
  const avg = Array.from({ length: 12 }, () => [0, 0]);
  const strategy = (i) => {
    const [r0, r1] = regret[i];
    const pos = [Math.max(r0, 0), Math.max(r1, 0)];
    const sum = pos[0] + pos[1];
    return sum > 0 ? [pos[0] / sum, pos[1] / sum] : [0.5, 0.5];
  };
  // Tree walk returning P1 EV; regrets updated in the acting player's
  // perspective against the current-strategy blend (vanilla CFR).
  function update(i, utils, s, oppReach, ownReach) {
    const blend = s[0] * utils[0] + s[1] * utils[1];
    regret[i][0] += oppReach * (utils[0] - blend);
    regret[i][1] += oppReach * (utils[1] - blend);
    avg[i][0] += ownReach * s[0];
    avg[i][1] += ownReach * s[1];
    return blend;
  }
  function walk(c1, c2, history, reach1, reach2) {
    if (history === "") { // P1 open with c1: [check, bet], P1 EVs
      const s = strategy(c1);
      const vCheck = walkCheck(c1, c2, reach1 * s[0], reach2);
      const vBet = walkBet(c1, c2, reach1 * s[1], reach2);
      return update(c1, [vCheck, vBet], s, reach2, reach1);
    }
    throw new Error("unreachable");
  }
  function walkBet(c1, c2, reach1, reach2) { // P2 facing bet with c2: [fold, call]
    const i = 9 + c2;
    const s = strategy(i);
    const vFold = 1;
    const vCall = c1 > c2 ? 2 : -2;
    update(i, [-vFold, -vCall], s, reach1, reach2); // P2 perspective = -P1 EV
    return s[0] * vFold + s[1] * vCall;
  }
  function walkCheck(c1, c2, reach1, reach2) { // P2 after check with c2: [check, bet]
    const i = 3 + c2;
    const s = strategy(i);
    const vCheck = c1 > c2 ? 1 : -1;
    const vBet = walkFacing(c1, c2, reach1, reach2 * s[1]);
    update(i, [-vCheck, -vBet], s, reach1, reach2);
    return s[0] * vCheck + s[1] * vBet;
  }
  function walkFacing(c1, c2, reach1, reach2) { // P1 facing bet with c1: [fold, call]
    const i = 6 + c1;
    const s = strategy(i);
    const vFold = -1;
    const vCall = c1 > c2 ? 2 : -2;
    return update(i, [vFold, vCall], s, reach2, reach1);
  }
  for (let t = 0; t < iterations; t++) {
    for (const c1 of [0, 1, 2]) {
      for (const c2 of [0, 1, 2]) {
        if (c1 !== c2) walk(c1, c2, "", 1 / 6, 1);
      }
    }
  }
  return avg.map(([a0, a1]) => (a0 + a1 > 0 ? a1 / (a0 + a1) : 0.5));
}

const nash = cfr(10000);

// Champion-equivalent: filled in after the bench run.
const champion = policyVersion(
  [0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1],
  null,
);

console.log(JSON.stringify({
  nashPolicy: nash.map((p) => Math.round(p * 1000) / 1000),
  nashExploitability: exploitability(nash),
  championExploitability: exploitability(champion.policy),
  nashEvVsChampion: ev(nash, champion.policy),
  championEvVsNash: ev(champion.policy, nash),
  gameValueP1: -1 / 18,
}, null, 2));
