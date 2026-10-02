// Rock-paper-scissors: "beat the last" vs "league", exact payoffs, $0.
// A strategy is a mix of 12 units over rock/paper/scissors. The league lives
// in the version: an accepted candidate inherits the champion's league plus
// the champion. Criteria are fixed in README.md.
//   node examples/league/rps.mjs [storage] [seeds] [rounds]
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";

export const N = 12;
export const implementation = { game: "rps-league-v1", file: readFileSync(new URL(import.meta.url), "utf8") };
const implementationId = digest(implementation);

export function rpsVersion(mix, league = [], parentId = null) {
  const content = { parentId, implementationId, mix, league };
  return Object.freeze({ id: digest(content), ...content });
}
const validMix = (m) => Array.isArray(m) && m.length === 3 && m.every((x) => Number.isSafeInteger(x) && x >= 0) &&
  m[0] + m[1] + m[2] === N;
function checkVersion(v) {
  if (!v || !validMix(v.mix) || !Array.isArray(v.league) || !v.league.every(validMix) ||
      rpsVersion(v.mix, v.league, v.parentId ?? null).id !== v.id) throw new Error("Invalid RPS version");
}

// Expected payoff of mix a against mix b, in [-1, 1]. Index i beats i - 1 (paper beats rock).
export const payoff = (a, b) => [0, 1, 2].reduce((s, i) => s + a[i] * (b[(i + 2) % 3] - b[(i + 1) % 3]), 0) / (N * N);
// Best pure response payoff against m: 0 for the uniform mix.
export const exploitability = (m) => Math.max(...[0, 1, 2].map((i) => (m[(i + 2) % 3] - m[(i + 1) % 3]) / N));

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Move 1..3 units from one action to another.
function propose(champion, round, seed) {
  const random = rng((seed + round * 0x9e3779b9) | 0);
  const from = Math.floor(random() * 3);
  const to = (from + 1 + Math.floor(random() * 2)) % 3;
  const k = Math.min(champion.mix[from], 1 + Math.floor(random() * 3));
  const mix = champion.mix.slice();
  mix[from] -= k;
  mix[to] += k;
  return rpsVersion(mix, [...champion.league, champion.mix], champion.id);
}

export function decide({ candidate, champion }, plan) {
  if (plan.rule === "exploit") {
    const gain = candidate[0] - champion[0];
    return { accepted: gain > 0, reason: `vs target ${candidate[0].toFixed(3)}, gain ${gain.toFixed(3)}` };
  }
  if (plan.rule === "last") {
    const edge = candidate.at(-1);
    return { accepted: edge > 0, reason: `vs champion ${edge.toFixed(3)}` };
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const worst = Math.min(...candidate.map((c, i) => c - champion[i]));
  const gain = mean(candidate) - mean(champion);
  return { accepted: gain > 0 && worst >= -plan.margin, reason: `league gain ${gain.toFixed(3)}, worst member ${worst.toFixed(3)}` };
}

export const adapter = {
  implementation,
  recovery: "repeatable",
  validatePlan(p) {
    if (!["last", "league", "exploit"].includes(p.rule) || (p.rule === "exploit" && !validMix(p.target)) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 ||
        !Number.isSafeInteger(p.seed) || !(p.margin >= 0)) throw new Error("Invalid RPS plan");
    checkVersion(p.initial);
  },
  validateVersion: checkVersion,
  limits: (p) => ({ executions: p.rounds, cost: 0 }),
  propose: (champion, history, p) => propose(champion, history.length, p.seed),
  // Opponents: the champion's league plus the champion (the candidate's league).
  // The exploiter faces only its frozen target.
  jobs: (champion, candidate, p) => [{ key: "payoffs", input: { candidate: candidate.mix, champion: champion.mix, opponents: p.rule === "exploit" ? [p.target] : candidate.league }, costLimit: 0 }],
  async execute({ input: { candidate, champion, opponents } }) {
    return { output: { candidate: opponents.map((o) => payoff(candidate, o)), champion: opponents.map((o) => payoff(champion, o)) }, cost: 0 };
  },
  grade: (_job, receipt) => ({ metrics: {}, data: receipt.output }),
  assess: (runs, plan) => {
    const evaluation = runs[0].observation.data;
    return { evaluation, decision: decide(evaluation, plan) };
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const storage = process.argv[2] ?? "./runs/league/rps.db";
  const seeds = Number(process.argv[3] ?? 5);
  const rounds = Number(process.argv[4] ?? 200);
  const margin = Number(process.argv[5] ?? 0.05);
  const learner = learnerHarness(storage, adapter);
  try {
    const rows = [];
    for (let s = 0; s < seeds; s++) {
      const row = { seed: s };
      for (const rule of ["last", "league"]) {
        // One experiment is capped at 100 rounds: chain links, champion handoff.
        let champion = rpsVersion([N, 0, 0]);
        const champions = [champion.mix];
        for (let link = 0; link * 100 < rounds; link++) {
          const id = `rps-${rule}-s${s}-l${link}`;
          await learner.startOrResume(id, { rule, rounds: Math.min(100, rounds - link * 100), seed: 1000 + 10 * s + link, margin, initial: champion });
          const state = await learner.wait(id);
          champions.push(...state.trials.filter((t) => t.accepted).map((t) => t.candidate.mix));
          champion = state.champion;
        }
        const final = champion.mix;
        row[rule] = {
          final,
          accepted: champions.length - 1,
          exploitability: Number(exploitability(final).toFixed(3)),
          // Mean payoff of the final champion against every past champion.
          vsHistory: Number((champions.slice(0, -1).reduce((a, m) => a + payoff(final, m), 0) / Math.max(1, champions.length - 1)).toFixed(3)),
        };
      }
      console.log(JSON.stringify(row));
      rows.push(row);
    }
    const passes = rows.filter((r) => r.last.exploitability >= 0.3 && r.league.exploitability <= 0.1).length;
    console.log(JSON.stringify({ passes, of: seeds, criterion: passes >= 4 ? "pass" : "fail" }));
  } finally {
    await learner.close();
  }
}
