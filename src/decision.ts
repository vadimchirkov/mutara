/** Fixed-sample bounded paired test. Use independent cases and fresh holdout data
 * for adaptively proposed candidates; repeatedly tuning on the same cases is not covered. */
export function boundedDecision(differences: number[], options: { minimumGain: number; range: number; alpha: number; comparisons: number }) {
  const { minimumGain, range, alpha, comparisons } = options;
  if (!differences.length || !Number.isFinite(minimumGain) || minimumGain < 0 || !Number.isFinite(range) || range <= 0 ||
      !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1 || !Number.isSafeInteger(comparisons) || comparisons < 1 ||
      differences.some((d) => !Number.isFinite(d) || Math.abs(d) > range / 2)) throw new Error("Invalid bounded comparison");
  const mean = differences.reduce((a, b) => a + b / differences.length, 0);
  // One-sided Hoeffding bound, Bonferroni allocation over the predeclared search.
  const lower = mean - range * Math.sqrt(Math.log(comparisons / alpha) / (2 * differences.length));
  return { accepted: lower > minimumGain, reason: `mean=${mean.toFixed(4)}, lower=${lower.toFixed(4)}, n=${differences.length}` };
}
