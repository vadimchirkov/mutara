// How many fake improvements does a Karpathy-style keep/discard loop accept, and how many
// does Mutara's gate stop? A simulation with known ground truth, not a measured gain on a
// real task.
//
//   node examples/autoresearch/simulate.mjs [--seeds 100] [--first-seed 0] [--proposals 100]
//
// Each proposal changes the champion's true quality by a hidden delta (logit units). The
// metric is a pass rate on cases of varying difficulty, so every evaluation is noisy.
// Three keep rules see the same proposals:
//   naive   autoresearch program.md: keep if the score on a fixed validation set beats the best so far
//   margin     community fix (autoresearch-overfit): keep only if it beats it by one standard error
//   gate       Mutara gate at its default alpha 0.05 per proposal: paired anytime-valid test on fresh cases
//   gate-loop  the same gate with alpha 0.05 split over all proposals of the run (Bonferroni)
// After the naive loop, one more gate compares its final champion with the starting code on
// AUDIT fresh cases: does the audit catch a branch whose claimed gain is not real?
//
// Equal budget (report.equalBudget): every rule gets BUDGET evaluations per run and takes
// proposals from one pre-drawn stream until the budget is spent. seq-<cap>-<alpha> is the
// paired sequential test on fresh cases, at most cap pairs per proposal; undecided = discard.
// Every rule ends with the same final audit. `criterion` applies the rule fixed in README.
import { gateDecision } from "teob-mutara/gate";

const args = process.argv.slice(2);
const flag = (name, fallback) => Number(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SEEDS = flag("--seeds", 100), FIRST_SEED = flag("--first-seed", 0), PROPOSALS = flag("--proposals", 100);
const POLICIES = ["naive", "margin", "gate", "gate-loop"];
const VALIDATION = 100, MAX_PAIRS = 300, AUDIT = 1000; // naive: one fixed set; gate: fresh cases, stops early

// Proposal mixes, fixed before the first run. "early" resembles the first night (big wins and
// losses), "late" the plateau where real gains are rare and small.
const REGIMES = {
  early: [[0.4, -0.3, 0.2], [0.3, 0, 0.02], [0.3, 0.4, 0.15]], // [share, mean delta, sd]
  late: [[0.5, -0.1, 0.05], [0.4, 0, 0.02], [0.1, 0.1, 0.05]],
};

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const drawDelta = (regime, r) => {
  let u = r();
  for (const [share, mean, sd] of REGIMES[regime]) if ((u -= share) < 0) return mean + sd * normal(r);
  return 0;
};
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const population = (() => { const r = rng(1); return Array.from({ length: 20000 }, () => 1.5 * normal(r)); })();
const truePassRate = (q) => population.reduce((a, d) => a + sigmoid(d + q), 0) / population.length;

function run(regime, seed) {
  const r = rng(1000 + seed);
  const draw = () => drawDelta(regime, r);
  const difficulty = () => 1.5 * normal(r);
  const passes = (q, d) => (r() < sigmoid(d + q) ? 1 : 0);
  const validation = Array.from({ length: VALIDATION }, difficulty); // reused every round, as in autoresearch
  const score = (q) => validation.reduce((a, d) => a + passes(q, d), 0) / VALIDATION;

  const paired = (candidate, baseline, n, alpha) => gateDecision(
    Array.from({ length: n }, () => { const d = difficulty(); return passes(candidate, d) - passes(baseline, d); }),
    { scoreRange: 1, minimumGain: 0, alpha });
  const policies = Object.fromEntries(POLICIES.map((p) => [p, { q: 0, kept: 0, falseKeeps: 0, harmful: 0, missed: 0, evaluations: 0 }]));
  for (const p of ["naive", "margin"]) { policies[p].best = policies[p].start = score(0); policies[p].evaluations += VALIDATION; }

  for (let i = 0; i < PROPOSALS; i++) {
    const delta = draw();
    for (const [name, s] of Object.entries(policies)) {
      let keep;
      if (name.startsWith("gate")) {
        const decision = paired(s.q + delta, s.q, MAX_PAIRS, name === "gate" ? 0.05 : 0.05 / PROPOSALS);
        s.evaluations += 2 * Number(/n=(\d+)/.exec(decision.reason)[1]); // the gate reports where it stopped
        keep = decision.accepted;
      } else {
        const candidate = score(s.q + delta);
        s.evaluations += VALIDATION;
        const se = Math.sqrt((2 * s.best * (1 - s.best)) / VALIDATION);
        keep = candidate > s.best + (name === "margin" ? se : 0);
        if (keep) s.best = candidate;
      }
      if (keep) { s.q += delta; s.kept++; if (delta <= 0) s.falseKeeps++; if (delta < -0.05) s.harmful++; }
      else if (delta > 0.05) s.missed++;
    }
  }
  const base = truePassRate(0);
  const audit = paired(policies.naive.q, 0, AUDIT, 0.05);
  const verdict = audit.accepted ? "promote" : audit.final ? "reject" : "inconclusive";
  return Object.fromEntries(Object.entries(policies).map(([name, s]) => [name, {
    kept: s.kept, falseKeeps: s.falseKeeps, harmful: s.harmful, missed: s.missed, evaluations: s.evaluations,
    trueGain: truePassRate(s.q) - base,
    claimedGain: name.startsWith("gate") ? null : s.best - s.start,
    ...(name === "naive" && { verdict, auditEvaluations: 2 * Number(/n=(\d+)/.exec(audit.reason)[1]) }),
  }]));
}

// Equal budget: the evaluations naive spends on PROPOSALS proposals, for every rule.
const BUDGET = VALIDATION + PROPOSALS * VALIDATION, STREAM = 1000;
const GRID = [25, 50, 100].flatMap((cap) => [0.05, 0.2].map((alpha) => ({ name: `seq-${cap}-${alpha}`, cap, alpha })));
const BUDGET_POLICIES = ["naive", "margin", ...GRID.map((g) => g.name)];
const stopped = (decision) => Number(/n=(\d+)/.exec(decision.reason)[1]); // pairs the test used

function runBudget(regime, seed, policy, stream) {
  const r = rng(1000 + seed); // evaluation noise; the proposals come from `stream`
  const difficulty = () => 1.5 * normal(r);
  const passes = (q, d) => (r() < sigmoid(d + q) ? 1 : 0);
  const paired = (candidate, baseline, n, alpha) => gateDecision(
    Array.from({ length: n }, () => { const d = difficulty(); return passes(candidate, d) - passes(baseline, d); }),
    { scoreRange: 1, minimumGain: 0, alpha });
  const seq = GRID.find((g) => g.name === policy);
  const s = { q: 0, proposals: 0, kept: 0, falseKeeps: 0, harmful: 0, evaluations: 0 };
  let score, best;
  if (!seq) {
    const validation = Array.from({ length: VALIDATION }, difficulty);
    score = (q) => validation.reduce((a, d) => a + passes(q, d), 0) / VALIDATION;
    best = score(0);
    s.evaluations += VALIDATION;
  }
  for (;;) {
    const remaining = BUDGET - s.evaluations;
    if (remaining < (seq ? 2 : VALIDATION)) break;
    if (s.proposals === STREAM) throw new Error("proposal stream exhausted; raise STREAM");
    const delta = stream[s.proposals++];
    let keep;
    if (seq) {
      // Out of budget mid-test, or cap reached undecided: not accepted, so discard.
      const decision = paired(s.q + delta, s.q, Math.min(seq.cap, Math.floor(remaining / 2)), seq.alpha);
      s.evaluations += 2 * stopped(decision);
      keep = decision.accepted;
    } else {
      const candidate = score(s.q + delta);
      s.evaluations += VALIDATION;
      keep = candidate > best + (policy === "margin" ? Math.sqrt((2 * best * (1 - best)) / VALIDATION) : 0);
      if (keep) best = candidate;
    }
    if (keep) { s.q += delta; s.kept++; if (delta <= 0) s.falseKeeps++; if (delta < -0.05) s.harmful++; }
  }
  const audit = paired(s.q, 0, AUDIT, 0.05);
  return { ...s, trueGain: truePassRate(s.q) - truePassRate(0), auditEvaluations: 2 * stopped(audit),
    verdict: audit.accepted ? "promote" : audit.final ? "reject" : "inconclusive" };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
const seeds = Array.from({ length: SEEDS }, (_, i) => FIRST_SEED + i);
const pp = (x) => +(100 * x).toFixed(2);
const equalBudget = {};
for (const regime of Object.keys(REGIMES)) {
  const runs = seeds.map((seed) => {
    const r = rng(5000 + seed), stream = Array.from({ length: STREAM }, () => drawDelta(regime, r));
    return Object.fromEntries(BUDGET_POLICIES.map((p) => [p, runBudget(regime, seed, p, stream)]));
  });
  const naiveGain = runs.map((x) => x.naive.trueGain);
  equalBudget[regime] = Object.fromEntries(BUDGET_POLICIES.map((p) => {
    const rs = runs.map((x) => x[p]), m = (k) => mean(rs.map((x) => x[k]));
    const diff = rs.map((x, i) => x.trueGain - naiveGain[i]); // paired by seed: same stream, same seed
    return [p, {
      proposals: +m("proposals").toFixed(1), kept: +m("kept").toFixed(2), falseKeeps: +m("falseKeeps").toFixed(2), harmfulKeeps: +m("harmful").toFixed(2),
      trueGainPp: pp(m("trueGain")), trueGainSePp: pp(se(rs.map((x) => x.trueGain))),
      worstTrueGainPp: pp(Math.min(...rs.map((x) => x.trueGain))),
      vsNaivePp: pp(mean(diff)), vsNaiveSePp: pp(se(diff)),
      evaluations: Math.round(m("evaluations")), maxEvaluations: Math.max(...rs.map((x) => x.evaluations)),
      finalAudit: Object.fromEntries(["promote", "reject", "inconclusive"].map((v) => [v, rs.filter((x) => x.verdict === v).length])),
      promotedWithoutTrueGain: rs.filter((x) => x.verdict === "promote" && x.trueGain <= 0).length,
      auditEvaluations: Math.round(m("auditEvaluations")),
      // Unrounded, for the criterion below.
      raw: { diff: mean(diff), diffSe: se(diff), harmful: m("harmful"), worst: Math.min(...rs.map((x) => x.trueGain)) },
    }];
  }));
}
// README criterion: beats naive by > 2 paired standard errors in both regimes, no more harmful
// keeps on average, worst seed not worse.
const passing = GRID.map((g) => g.name).filter((p) => Object.values(equalBudget).every((reg) =>
  reg[p].raw.diff > 2 * reg[p].raw.diffSe && reg[p].raw.harmful <= reg.naive.raw.harmful && reg[p].raw.worst >= reg.naive.raw.worst));
for (const reg of Object.values(equalBudget)) for (const p of Object.values(reg)) delete p.raw;

const report = {};
for (const regime of Object.keys(REGIMES)) {
  const runs = seeds.map((seed) => run(regime, seed));
  report[regime] = Object.fromEntries(POLICIES.map((p) => {
    const rs = runs.map((x) => x[p]);
    const m = (k) => mean(rs.map((x) => x[k]));
    return [p, {
      kept: +m("kept").toFixed(1), falseKeeps: +m("falseKeeps").toFixed(1), harmfulKeeps: +m("harmful").toFixed(1), missedGains: +m("missed").toFixed(1),
      trueGainPp: +(100 * m("trueGain")).toFixed(1),
      worstTrueGainPp: +(100 * Math.min(...rs.map((x) => x.trueGain))).toFixed(1),
      claimedGainPp: p.startsWith("gate") ? null : +(100 * m("claimedGain")).toFixed(1),
      evaluations: Math.round(m("evaluations")),
      ...(p === "naive" && { auditEvaluations: Math.round(m("auditEvaluations")), finalAudit: Object.fromEntries(["promote", "reject", "inconclusive"].map((v) => [v, rs.filter((x) => x.verdict === v).length])),
        promotedWithoutTrueGain: rs.filter((x) => x.verdict === "promote" && x.trueGain <= 0).length,
        trueGainAbove1ppNotPromoted: rs.filter((x) => x.verdict !== "promote" && x.trueGain > 0.01).length }),
    }];
  }));
}
console.log(JSON.stringify({ seeds: SEEDS, firstSeed: FIRST_SEED, proposals: PROPOSALS, validation: VALIDATION, maxPairs: MAX_PAIRS, audit: AUDIT, report,
  equalBudget: { budget: BUDGET, regimes: equalBudget, criterion: { passing } },
  note: "Simulation with known ground truth; not a measured gain on a real task." }, null, 2));
