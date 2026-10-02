// Self-play vs league on Connect-4, same proposer, rounds and seeds, several
// replicates. Replicate 0 uses the seeds of the measured self-play chain.
// Criteria are fixed in examples/league/README.md.
//   node examples/connect4/league-paired-bench.mjs [storage] [replicates]
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter as spAdapter, buildSpPlan, v2Champion } from "./selfplay.mjs";
import { adapter as leagueAdapter, buildLeaguePlan, leagueVersion, played } from "./league-paired.mjs";
import { baselineMove, versionMove } from "./strategy.mjs";
import { emptyBoard, winner, isDraw, apply, rng } from "./game.mjs";

const LINKS = 3;
const ROUNDS_PER_LINK = 8;
const SEEDS_PER_SET = 64;
const storage = process.argv[2] ?? "./runs/c4/league-bench.db";
const REPLICATES = Number(process.argv[3] ?? 5);
const HELD_OUT = Array.from({ length: 200 }, (_, i) => 9_000_000 + i);

// Same match as sp-bench.mjs: X = first policy, starter by seed parity.
const policyOf = (version) => (board, player, rand) => versionMove(version, board, player, rand);
const basePolicy = (board, player, rand) => baselineMove(board, player, rand, { uctC: 1.4, simulations: 15 });
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
  return rs.reduce((a, b) => a + b, 0) / rs.length;
}

const arms = {
  selfplay: {
    learner: learnerHarness(storage, spAdapter),
    initial: () => v2Champion(),
    plan: (o) => buildSpPlan(o),
    strategy: (v) => v,
  },
  league: {
    learner: learnerHarness(storage.replace(/\.db$/, "-league.db"), leagueAdapter),
    initial: () => leagueVersion(v2Champion()),
    plan: (o) => buildLeaguePlan(o),
    strategy: (v) => v.strategy,
  },
};

async function chain(name, r) {
  const arm = arms[name];
  const before = played.games;
  let initial = arm.initial();
  let executions = 0;
  const accepted = [];
  for (let i = 1; i <= LINKS; i++) {
    const offset = r * 100_000 + i * 10_000;
    const id = `c4-${name}-r${r}-l${i}`;
    await arm.learner.startOrResume(id, arm.plan({
      rounds: ROUNDS_PER_LINK,
      seed: 7919 + 100 * r + i,
      minimumGain: 0.03,
      initial,
      trainingSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => offset + 101 + k),
      validationSeeds: Array.from({ length: SEEDS_PER_SET }, (_, k) => offset + 1001 + k),
    }));
    const state = await arm.learner.wait(id);
    executions += state.executions;
    accepted.push(state.trials.filter((t) => t.accepted).length);
    initial = state.champion;
  }
  const final = policyOf(arm.strategy(initial));
  return {
    accepted,
    games: name === "league" ? played.games - before : executions * SEEDS_PER_SET,
    leagueSize: initial.league?.length,
    components: arm.strategy(initial).components,
    vsFixed: match(final, basePolicy, HELD_OUT),
    vsV2: match(final, policyOf(v2Champion()), HELD_OUT),
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);

try {
  const rows = [];
  for (let r = 0; r < REPLICATES; r++) {
    const row = { replicate: r, selfplay: await chain("selfplay", r), league: await chain("league", r) };
    console.log(JSON.stringify(row));
    rows.push(row);
  }
  const sp = rows.map((x) => x.selfplay.vsFixed);
  const lg = rows.map((x) => x.league.vsFixed);
  const diff = rows.map((x) => x.league.vsFixed - x.selfplay.vsFixed);
  const pass = mean(lg) >= 0.715 && mean(diff) > 2 * se(diff);
  console.log(JSON.stringify({
    v2VsFixed: match(policyOf(v2Champion()), basePolicy, HELD_OUT),
    selfplay: { vsFixed: mean(sp), se: se(sp), games: mean(rows.map((x) => x.selfplay.games)) },
    league: { vsFixed: mean(lg), se: se(lg), games: mean(rows.map((x) => x.league.games)) },
    difference: { mean: mean(diff), se: se(diff) },
    criterion: pass ? "pass" : "fail",
  }, null, 2));
} finally {
  await arms.selfplay.learner.close();
  await arms.league.learner.close();
}
