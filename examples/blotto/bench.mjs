// Experiment 4: last vs league vs league+exploiter on Colonel Blotto, $0.
// 400 rounds per arm. Criteria are fixed in README.md.
//   node examples/blotto/bench.mjs [storage] [seeds] [links]
// links < full shortens every arm (smoke only, not a result).
import { learnerHarness } from "teob-mutara/sqlite";
import { adapter, blottoVersion, payoff, exploitability, pureStrategies, rng, K } from "./blotto.mjs";

const storage = process.argv[2] ?? "./runs/blotto/bench.db";
const seeds = Number(process.argv[3] ?? 10);
const links = process.argv[4] === undefined ? null : Number(process.argv[4]);
const learner = learnerHarness(storage, adapter);
const fix = (x) => Number(x.toFixed(4));
// Start of seed s: a random mix of K pure strategies (also reference point 3).
const randomMix = (s) => {
  const all = pureStrategies(), r = rng(9000 + s);
  return Array.from({ length: K }, () => all[Math.floor(r() * all.length)]);
};
const start = (s) => blottoVersion(randomMix(s));

async function run(id, plan) {
  await learner.startOrResume(id, { margin: 2, ...plan });
  return learner.wait(id);
}

function report(champion, accepted, extra = {}) {
  return {
    final: champion.mix,
    accepted,
    leagueSize: champion.league.length,
    exploitability: fix(exploitability(champion.mix)),
    leagueExploitability: champion.league.length ? fix(exploitability(champion.league.flat())) : null,
    ...extra,
  };
}

// last and league: 4 links x 100 rounds.
async function plainArm(rule, s) {
  let champion = start(s);
  let accepted = 0;
  for (let link = 0; link < (links ?? 4); link++) {
    const state = await run(`blotto-${rule}-s${s}-l${link}`, { rule, rounds: 100, seed: 1000 + 100 * s + link, initial: champion });
    accepted += state.trials.filter((t) => t.accepted).length;
    champion = state.champion;
  }
  return report(champion, accepted);
}

// league+exploiter: 20 links x (10 exploiter + 10 main rounds).
async function exploiterArm(s) {
  let champion = start(s);
  let accepted = 0, injected = 0;
  for (let link = 0; link < (links ?? 20); link++) {
    const exploiter = await run(`blotto-lx-s${s}-l${link}-x`, {
      rule: "exploit", target: champion.mix, rounds: 10, seed: 5000 + 100 * s + link, initial: blottoVersion(champion.mix),
    });
    if (payoff(exploiter.champion.mix, champion.mix) > 0) {
      champion = blottoVersion(champion.mix, [...champion.league, exploiter.champion.mix], champion.id);
      injected += 1;
    }
    const state = await run(`blotto-lx-s${s}-l${link}`, { rule: "league", rounds: 10, seed: 1000 + 100 * s + link, initial: champion });
    accepted += state.trials.filter((t) => t.accepted).length;
    champion = state.champion;
  }
  return report(champion, accepted, { injected });
}

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean: fix(mean), se: fix(sd / Math.sqrt(xs.length)) };
};

try {
  const random = Array.from({ length: seeds }, (_, s) => exploitability(randomMix(s)));
  console.log(JSON.stringify({ pure: pureStrategies().length, even: exploitability([[4, 4, 4, 4, 4]]), randomMix: stats(random) }));
  const rows = [];
  for (let s = 0; s < seeds; s++) {
    const row = { seed: s, last: await plainArm("last", s), league: await plainArm("league", s), lx: await exploiterArm(s) };
    console.log(JSON.stringify(row));
    rows.push(row);
  }
  const summary = {};
  for (const arm of ["last", "league", "lx"]) {
    summary[arm] = {
      exploitability: stats(rows.map((r) => r[arm].exploitability)),
      leagueExploitability: stats(rows.map((r) => r[arm].leagueExploitability ?? NaN)),
      accepted: stats(rows.map((r) => r[arm].accepted)),
    };
  }
  summary.lx.injected = stats(rows.map((r) => r.lx.injected));
  const diff = stats(rows.map((r) => r.last.exploitability - r.lx.exploitability));
  console.log(JSON.stringify({ summary, lastMinusLx: diff, criterion: diff.mean > 2 * diff.se ? "pass" : "fail" }));
} finally {
  await learner.close();
}
