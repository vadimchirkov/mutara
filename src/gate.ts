import { sequentialDecision } from "./decision.js";
import type { RunRecord } from "./engine.js";
import { learnerHarness } from "./sqlite.js";
import { digest, validateVersion, version, type Version } from "./version.js";

export interface GateCase { id: string; input: unknown; expected?: unknown }
export interface GateReceipt { output: unknown; cost: number }
export interface GateGrade { score: number; violation?: number }
export interface GateOptions {
  id: string;
  storage: string;
  /** Finite JSON pinning both runners, models and the scorer. Never credentials. */
  implementation: unknown;
  /** Fresh cases: never used to tune either side. */
  cases: GateCase[];
  baseline: (c: GateCase) => Promise<GateReceipt>;
  candidate: (c: GateCase) => Promise<GateReceipt>;
  score: (output: unknown, c: GateCase) => GateGrade;
  /** Max − min possible score of one case. */
  scoreRange: number;
  /**
   * Required mean gain of candidate over baseline. 0 (default): candidate must be better.
   * Negative: non-inferiority, e.g. -0.02 lets a cheaper candidate be up to 0.02 worse.
   */
  minimumGain?: number;
  alpha?: number;
  /** Reserved cost per runner call, in the runners' units (default 1e6). A receipt above it fails the gate. */
  costLimit?: number;
  /** Stop as soon as the anytime-valid test is decisive (default true). */
  early?: boolean;
  concurrency?: number;
  recovery?: "repeatable" | "idempotent" | "manual";
}
export interface GateSide { mean: number; violations: number; cost: number }
export interface GateResult {
  /** promote: test passed and violations did not grow; reject: futility or more violations; inconclusive: not enough evidence. */
  verdict: "promote" | "reject" | "inconclusive";
  reason: string;
  /** Paired cases evaluated (fewer than `cases` when the test stopped early). */
  cases: number;
  baseline: GateSide;
  candidate: GateSide;
}

/**
 * Anytime-valid paired test that mean(candidate − baseline) > minimumGain, which may be negative
 * (non-inferiority). Testing mean(d) > m is testing mean(d − m) > 0 on a range widened so every
 * shifted difference stays in bounds.
 */
export function gateDecision(differences: number[], options: { scoreRange: number; minimumGain: number; alpha: number }) {
  const { scoreRange, minimumGain, alpha } = options;
  return sequentialDecision(differences.map((d) => d - minimumGain),
    { minimumGain: 0, range: 2 * (scoreRange + Math.abs(minimumGain)), alpha, comparisons: 1 });
}

type Evaluation = { verdict: GateResult["verdict"]; reason: string; pairs: number; baseline: GateSide; candidate: GateSide };

/** Journaled paired comparison of two runners on fresh cases; re-running with the same id resumes without repeating finished calls. */
export async function gate(opts: GateOptions): Promise<GateResult> {
  const minimumGain = opts.minimumGain ?? 0, alpha = opts.alpha ?? 0.05;
  if (!opts.cases.length || new Set(opts.cases.map((c) => c.id)).size !== opts.cases.length) throw new Error("gate needs cases with unique ids");
  if (!(opts.scoreRange > 0) || !Number.isFinite(minimumGain) || Math.abs(minimumGain) >= opts.scoreRange || !(alpha > 0 && alpha < 1)) {
    throw new Error("gate needs scoreRange > 0, |minimumGain| < scoreRange and alpha in (0, 1)");
  }
  const costLimit = opts.costLimit ?? 1e6;
  if (!(costLimit >= 0 && Number.isFinite(costLimit))) throw new Error("gate costLimit must be finite and nonnegative");
  const byId = new Map(opts.cases.map((c) => [c.id, c]));
  const implementation = { role: "mutara-gate-v1", task: opts.implementation, cases: opts.cases.map((c) => c.id), minimumGain, alpha,
    scoreRange: opts.scoreRange, costLimit, early: opts.early ?? true };
  const implId = digest(implementation);
  const plan = { initial: version({ side: "baseline" }, implId), rounds: 1 };
  const test = (d: number[]) => gateDecision(d, { scoreRange: opts.scoreRange, minimumGain, alpha });
  const pairs = (runs: RunRecord[]) => {
    const seen = new Map<string, { baseline?: RunRecord; candidate?: RunRecord }>();
    for (const r of runs) {
      const [side, caseId] = r.job.key.split(":", 2) as ["baseline" | "candidate", string];
      seen.set(caseId, { ...seen.get(caseId), [side]: r });
    }
    return [...seen.values()].filter((p) => p.baseline?.observation && p.candidate?.observation) as { baseline: RunRecord; candidate: RunRecord }[];
  };
  const side = (rs: RunRecord[]): GateSide => ({
    mean: rs.reduce((a, r) => a + r.observation!.metrics.score!, 0) / Math.max(rs.length, 1),
    violations: rs.reduce((a, r) => a + r.observation!.metrics.violation!, 0),
    cost: rs.reduce((a, r) => a + (r.receipt?.cost ?? 0), 0),
  });

  type Side = Version<{ side: string }>;
  const h = learnerHarness<Side, { initial: Side; rounds: number }, Evaluation>(opts.storage, {
    implementation, recovery: opts.recovery ?? "repeatable",
    validatePlan: (p) => { if (digest(p) !== digest(plan)) throw new Error("Gate plan changed; use a new id"); },
    validateVersion: (v) => validateVersion(v, implId),
    limits: () => ({ executions: 2 * opts.cases.length, cost: 2 * opts.cases.length * costLimit }),
    propose: (initial) => version({ side: "candidate" }, implId, initial.id),
    // Interleaved so every prefix is paired, which is what early stopping assesses.
    jobs: () => opts.cases.flatMap((c) => (["baseline", "candidate"] as const).map((s) => ({ key: `${s}:${c.id}`, input: { side: s, caseId: c.id }, costLimit }))),
    execute: async (job) => {
      const { side: s, caseId } = job.input as { side: "baseline" | "candidate"; caseId: string };
      const receipt = await (s === "baseline" ? opts.baseline : opts.candidate)(byId.get(caseId)!);
      if (!Number.isFinite(receipt.cost) || receipt.cost < 0) throw new Error("Runner cost must be a finite nonnegative number");
      return receipt;
    },
    grade: (job, receipt) => {
      const g = opts.score(receipt.output, byId.get((job.input as { caseId: string }).caseId)!);
      const violation = g.violation ?? 0;
      if (!Number.isFinite(g.score) || !Number.isFinite(violation) || violation < 0) throw new Error("Score and nonnegative violation must be finite numbers");
      return { metrics: { score: g.score, violation }, data: null };
    },
    early: (runs) => (opts.early ?? true) && pairs(runs).length > 0 && test(pairs(runs).map((p) => p.candidate.observation!.metrics.score! - p.baseline.observation!.metrics.score!)).final === true,
    assess: (runs) => {
      const ps = pairs(runs);
      const differences = ps.map((p) => p.candidate.observation!.metrics.score! - p.baseline.observation!.metrics.score!);
      if (differences.some((d) => Math.abs(d) > opts.scoreRange)) throw new Error("Scores exceed scoreRange");
      const baseline = side(ps.map((p) => p.baseline)), candidate = side(ps.map((p) => p.candidate));
      const decision = differences.length ? test(differences) : { accepted: false, final: false, reason: "n=0" };
      const safe = candidate.violations <= baseline.violations;
      const verdict = !safe ? "reject" : decision.accepted ? "promote" : decision.final ? "reject" : "inconclusive";
      const reason = `${decision.reason}${safe ? "" : "; violations increased"}`;
      const evaluation: Evaluation = { verdict, reason, pairs: ps.length, baseline, candidate };
      return { evaluation, decision: { accepted: verdict === "promote", reason } };
    },
  }, { category: "mutara-gate", concurrency: opts.concurrency ?? 1 });
  try {
    await h.startOrResume(opts.id, plan);
    const e = (await h.wait(opts.id, 3_600_000)).trials[0]!.evaluation as Evaluation;
    return { verdict: e.verdict, reason: e.reason, cases: e.pairs, baseline: e.baseline, candidate: e.candidate };
  } finally {
    await h.close();
  }
}
