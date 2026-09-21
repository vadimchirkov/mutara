// Self-play chain for Connect-4: each link a new ID with fresh seeds, the
// link champion becomes the next link's sparring partner AND initial.
// Final guards: fixed baseline, deep MCTS, and the v2 champion head-to-head
// (cycle detection). Uses only public exports: mutara/sqlite.
import { learnerHarness } from "mutara/sqlite";
import { adapter, buildSpPlan, playGame, v2Champion } from "./selfplay.mjs";
import { initialVersion, baselineMove } from "./strategy.mjs";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";

const LINKS = 3;
const ROUNDS_PER_LINK = 8;
const SEEDS_PER_SET = 64;
const storage = process.argv[2] ?? "./examples/connect4/sp-chain.db";

const learner = learnerHarness(storage, adapter);
try {
  let initial = v2Champion();
  const links = [];
  for (let i = 1; i <= LINKS; i++) {
    const id = `c4-sp-l${i}`;
    const plan = buildSpPlan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + i,
      minimumGain: 0.03,
      initial,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => i * 10_000 + 1001 + k),
    });
    await learner.startOrResume(id, plan);
    const state = await learner.wait(id);
    links.push({
      id,
      trials: state.trials.length,
      accepted: state.trials.filter((t) => t.accepted).length,
      championComponents: state.champion.components,
      executions: state.executions,
    });
    initial = state.champion;
  }
  console.log(JSON.stringify({ links }, null, 2));

  // Guards on fresh seeds. vsFixed: X=final vs MCTS-15 baseline (v2 metric).
  // vsDeep: final vs 500-sim MCTS (the 0.15 gap). vsV2: cycle detection.
  const HELD_OUT = Array.from({ length: 200 }, (_, i) => 9_000_000 + i);
  const { versionMove } = await import("./strategy.mjs");
  const policyOf = (version) => (board, player, rand) => versionMove(version, board, player, rand);
  const basePolicy = (board, player, rand) => baselineMove(board, player, rand, { uctC: 1.4, simulations: 15 });
  const deepPolicy = (board, player, rand) => baselineMove(board, player, rand, { uctC: 1.4, simulations: 500 });
  function match(px, po, seeds) {
    const rs = seeds.map((s) => {
      const rx = rng(((s * 2654435761) ^ 0x1234abcd) | 0);
      const ro = rng(((s * 2654435761) ^ 0x5678dcba) | 0);
      let board = emptyBoard();
      let toMove = s % 2 === 0 ? "X" : "O";
      while (true) {
        const w = winner(board);
        if (w) return w === "X" ? 1 : 0;
        if (isDraw(board)) return 0.5;
        const move = toMove === "X" ? px(board, "X", rx) : po(board, "O", ro);
        board = apply(board, move, toMove);
        toMove = toMove === "X" ? "O" : "X";
      }
    });
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    return { mean, wins: rs.filter((r) => r === 1).length, draws: rs.filter((r) => r === 0.5).length, losses: rs.filter((r) => r === 0).length };
  }
  const fin = policyOf(initial);
  console.log(JSON.stringify({
    heldOut: HELD_OUT.length,
    vsFixed: match(fin, basePolicy, HELD_OUT),
    fixedVsFinal: match(basePolicy, fin, HELD_OUT),
    vsDeep100: match(fin, deepPolicy, HELD_OUT.slice(0, 100)),
    vsV2: match(fin, policyOf(v2Champion()), HELD_OUT),
  }, null, 2));
} finally {
  await learner.close();
}
