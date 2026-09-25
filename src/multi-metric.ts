import { boundedDecision, sequentialDecision } from "./decision.js";

export interface Metric {
  name: string;
  direction: "higher" | "lower";
  weight: number;
  /** Fixed task bounds, declared before observing results. Required for bounded decisions. */
  bounds?: { min: number; max: number };
}
export type DecisionRule =
  | { mode: "bounded"; minimumGain?: number; alpha?: number }
  /** Anytime-valid; the optimizer stops a trial as soon as the evidence is decisive. */
  | { mode: "sequential"; minimumGain?: number; alpha?: number }
  | { mode: "heuristic"; minimumGain?: number };

export function validateMetrics(metrics: Metric[]) {
  if (!metrics.length) throw new Error("At least one metric required");
  if (new Set(metrics.map((m) => m.name)).size !== metrics.length) throw new Error("Duplicate metric names");
  for (const m of metrics) {
    if (!m.name || !["higher", "lower"].includes(m.direction) || !Number.isFinite(m.weight) || m.weight <= 0) throw new Error(`Invalid metric ${m.name}`);
    if (m.bounds && (!Number.isFinite(m.bounds.min) || !Number.isFinite(m.bounds.max) || m.bounds.min >= m.bounds.max)) throw new Error(`Invalid bounds for ${m.name}`);
  }
}

export function validateScores(scores: Record<string, number>, metrics: Metric[]) {
  for (const m of metrics) {
    const value = scores?.[m.name];
    if (typeof value !== "number" || !Number.isFinite(value) ||
        (m.bounds && (value < m.bounds.min || value > m.bounds.max))) throw new Error(`Invalid observation for ${m.name}`);
  }
}

export function compositeDecision(
  baseline: Record<string, number>[],
  candidate: Record<string, number>[],
  metrics: Metric[],
  options: DecisionRule & { comparisons: number },
): { accepted: boolean; reason: string; final?: boolean } {
  if (baseline.length !== candidate.length || !baseline.length) throw new Error("Sample counts must match and be non-empty");
  validateMetrics(metrics);
  const minimumGain = options.minimumGain ?? 0;
  if (!Number.isFinite(minimumGain) || minimumGain < 0 || !Number.isSafeInteger(options.comparisons) || options.comparisons < 1) throw new Error("Invalid decision rule");
  const composites = baseline.map((b, i) => {
    validateScores(b, metrics);
    validateScores(candidate[i], metrics);
    let sum = 0;
    for (const m of metrics) {
      const diff = candidate[i][m.name] - b[m.name];
      sum += m.weight * (m.direction === "lower" ? -diff : diff);
    }
    if (!Number.isFinite(sum)) throw new Error("Composite score overflow");
    return sum;
  });
  if (options.mode === "heuristic") {
    const mean = composites.reduce((a, b) => a + b / composites.length, 0);
    if (!Number.isFinite(mean)) throw new Error("Composite mean overflow");
    return { accepted: mean > minimumGain, reason: `heuristic mean=${mean.toFixed(4)}, n=${composites.length}` };
  }
  if (!["bounded", "sequential"].includes(options.mode) || metrics.some((m) => !m.bounds)) throw new Error("Bounded decisions require fixed metric bounds");
  const range = 2 * metrics.reduce((sum, m) => sum + m.weight * (m.bounds!.max - m.bounds!.min), 0);
  const test = options.mode === "sequential" ? sequentialDecision : boundedDecision;
  return test(composites, { minimumGain, comparisons: options.comparisons, range, alpha: options.alpha ?? 0.05 });
}
