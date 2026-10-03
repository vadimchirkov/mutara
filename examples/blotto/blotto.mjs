// Colonel Blotto: 20 soldiers on 5 fields, exact payoffs, $0.
// A version is a mix of K = 4 distributions with equal weights. The league
// lives in the version, as in ../league/rps.mjs. Criteria are fixed in README.md.
import { readFileSync } from "node:fs";
import { digest } from "teob-mutara";
import { decide } from "../league/rps.mjs";

export const SOLDIERS = 20;
export const FIELDS = 5;
export const K = 4;
export const implementation = { game: "blotto-league-v1", file: readFileSync(new URL(import.meta.url), "utf8") };
const implementationId = digest(implementation);

export function blottoVersion(mix, league = [], parentId = null) {
  const content = { parentId, implementationId, mix, league };
  return Object.freeze({ id: digest(content), ...content });
}
const validDist = (d) => Array.isArray(d) && d.length === FIELDS && d.every((x) => Number.isSafeInteger(x) && x >= 0) &&
  d.reduce((a, b) => a + b, 0) === SOLDIERS;
const validMix = (m) => Array.isArray(m) && m.length === K && m.every(validDist);
function checkVersion(v) {
  if (!v || !validMix(v.mix) || !Array.isArray(v.league) || !v.league.every(validMix) ||
      blottoVersion(v.mix, v.league, v.parentId ?? null).id !== v.id) throw new Error("Invalid Blotto version");
}

// Pure match: +1 / 0 / -1 by fields held, a tied field counts 0.5 to each side.
export function duel(a, b) {
  let fields = 0;
  for (let i = 0; i < FIELDS; i++) fields += a[i] > b[i] ? 1 : a[i] === b[i] ? 0.5 : 0;
  return Math.sign(fields - FIELDS / 2);
}
// Expected payoff of one equal-weight set of distributions against another.
export function payoff(a, b) {
  let s = 0;
  for (const x of a) for (const y of b) s += duel(x, y);
  return s / (a.length * b.length);
}

let pure;
export function pureStrategies() {
  if (pure) return pure;
  pure = [];
  const walk = (prefix, left) => {
    if (prefix.length === FIELDS - 1) return void pure.push([...prefix, left]);
    for (let x = 0; x <= left; x++) walk([...prefix, x], left - x);
  };
  walk([], SOLDIERS);
  return pure;
}
// Best pure response payoff against an equal-weight set of distributions. 0 = unexploitable.
export const exploitability = (dists) => Math.max(...pureStrategies().map((p) => payoff([p], dists)));

export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Replace one of the K distributions with a mutation: move 1..3 soldiers between two fields.
function propose(champion, round, seed) {
  const random = rng((seed + round * 0x9e3779b9) | 0);
  const j = Math.floor(random() * K);
  const from = Math.floor(random() * FIELDS);
  const to = (from + 1 + Math.floor(random() * (FIELDS - 1))) % FIELDS;
  const dist = champion.mix[j].slice();
  const k = Math.min(dist[from], 1 + Math.floor(random() * 3));
  dist[from] -= k;
  dist[to] += k;
  const mix = champion.mix.map((d, i) => (i === j ? dist : d));
  return blottoVersion(mix, [...champion.league, champion.mix], champion.id);
}

// Rules as in rps.mjs: "last" = beat the champion, "league" with margin 2 =
// mean over the league only (payoffs lie in [-1, 1]), "exploit" = beat the frozen target.
export const adapter = {
  implementation,
  recovery: "repeatable",
  validatePlan(p) {
    if (!["last", "league", "exploit"].includes(p.rule) || (p.rule === "exploit" && !validMix(p.target)) || !Number.isSafeInteger(p.rounds) || p.rounds < 1 ||
        !Number.isSafeInteger(p.seed) || p.margin !== 2) throw new Error("Invalid Blotto plan");
    checkVersion(p.initial);
  },
  validateVersion: checkVersion,
  limits: (p) => ({ executions: p.rounds, cost: 0 }),
  propose: (champion, history, p) => propose(champion, history.length, p.seed),
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
