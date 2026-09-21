// Ceiling check: exact DP is overkill here; the reference is the best fixed
// hold-at-K threshold found by round-robin on fresh seeds. Pure evaluation,
// no journal. Tells whether the learned champion beats the best simple rule.
import { initialState, winner, apply, rng } from "./game.mjs";
import { strategyVersion, versionMove, holdAt } from "./strategy.mjs";

const die = (rand) => 1 + Math.floor(rand() * 6);

function play(policyX, policyO, sample) {
  const randDecide = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const randDice = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let state = initialState();
  if (sample % 2 === 1) state = { ...state, toMove: "O" };
  while (true) {
    const w = winner(state);
    if (w) return w === "X" ? 1 : 0;
    const move = state.toMove === "X"
      ? policyX(state, "X", randDecide)
      : policyO(state, "O", randDecide);
    state = apply(state, move, die(randDice));
  }
}

// Champion-equivalent from pig-comp-v1.
const champion = strategyVersion(
  { uctC: 1.4, simulations: 15 },
  null,
  [
    { feature: "chase", weight: 0.25, when: "always" },
    { feature: "pressLuck", weight: 0.25, when: "always" },
    { feature: "takeWin", weight: 0.5, when: "always" },
  ],
);
const champPolicy = (s, p, r) => versionMove(champion, s, p, r);

const N = 200;
const seeds = Array.from({ length: N }, (_, i) => 3_000_000 + i);
const score = (px, po) => {
  const rs = seeds.map((s) => play(px, po, s));
  return { mean: rs.reduce((a, x) => a + x, 0) / N, wins: rs.filter((x) => x === 1).length, losses: rs.filter((x) => x === 0).length };
};

// Round-robin over thresholds: each K plays every other K, both sides.
const KS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const policies = Object.fromEntries(KS.map((k) => [k, holdAt(k)]));
const table = KS.map((k) => {
  let total = 0;
  let games = 0;
  for (const j of KS) {
    if (j === k) continue;
    total += score(policies[k], policies[j]).mean + (1 - score(policies[j], policies[k]).mean);
    games += 2;
  }
  return { k, mean: total / games };
});
table.sort((a, b) => b.mean - a.mean);
const refK = table[0].k;

console.log(JSON.stringify({
  games: N,
  roundRobin: table,
  reference: `hold-at-${refK}`,
  championVsRef: score(champPolicy, policies[refK]),
  refVsChampion: score(policies[refK], champPolicy),
}, null, 2));
