// Ceiling proxy: exact minimax is infeasible on 5x5, so the reference is a
// deep MCTS (500 sims). Pure evaluation, no journal.
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";
import { strategyVersion, versionMove, baselineMove } from "./strategy.mjs";

const DEEP = { uctC: 1.4, simulations: 500 };

function play(policyX, policyO, sample) {
  const rx = rng(((sample * 2654435761) ^ 0x1234abcd) | 0);
  const ro = rng(((sample * 2654435761) ^ 0x5678dcba) | 0);
  let board = emptyBoard();
  let toMove = sample % 2 === 0 ? "X" : "O";
  while (true) {
    const w = winner(board);
    if (w) return w === "X" ? 1 : 0;
    if (isDraw(board)) return 0.5;
    const move = toMove === "X" ? policyX(board, "X", rx) : policyO(board, "O", ro);
    board = apply(board, move, toMove);
    toMove = toMove === "X" ? "O" : "X";
  }
}

// Champion-equivalent from c4-comp-v2.
const champion = strategyVersion(
  { uctC: 1.4, simulations: 15 },
  null,
  [
    { feature: "blockWin", weight: 0.5, when: "always" },
    { feature: "center", weight: 1, when: "always" },
    { feature: "takeWin", weight: 0.5, when: "always" },
  ],
);
const champPolicy = (b, p, r) => versionMove(champion, b, p, r);
const basePolicy = (b, p, r) => baselineMove(b, p, r, { uctC: 1.4, simulations: 15 });
const deepPolicy = (b, p, r) => baselineMove(b, p, r, DEEP);

const N = Number(process.argv[2] ?? 100);
const seeds = Array.from({ length: N }, (_, i) => 3_000_000 + i);
const score = (px, po) => {
  const rs = seeds.map((s) => play(px, po, s));
  return { mean: rs.reduce((a, x) => a + x, 0) / N, wins: rs.filter((x) => x === 1).length, draws: rs.filter((x) => x === 0.5).length, losses: rs.filter((x) => x === 0).length };
};

console.log(JSON.stringify({
  games: N,
  reference: "deep-mcts-500",
  championVsDeep: score(champPolicy, deepPolicy),
  deepVsChampion: score(deepPolicy, champPolicy),
  baselineVsDeep: score(basePolicy, deepPolicy),
  deepVsBaseline: score(deepPolicy, basePolicy),
}, null, 2));
