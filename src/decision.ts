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

/** Anytime-valid paired test by betting (Waudby-Smith & Ramdas, aGRAPA bets): valid under
 * optional stopping, so evaluation can stop once `final` is true. Same data caveats as above. */
export function sequentialDecision(differences: number[], options: { minimumGain: number; range: number; alpha: number; comparisons: number }) {
  boundedDecision(differences, options); // shared validation
  const { minimumGain, range, alpha, comparisons } = options;
  const null0 = (minimumGain + range / 2) / range; // null mean on the [0, 1] scale
  if (null0 >= 1) throw new Error("Invalid bounded comparison");
  // Futility wealth ≥ 20 rejects early; it can drop a truly better candidate with probability ≤ 5%.
  let wealth = 1, futility = 1, sum = 0, squares = 0, n = 0;
  const reason = () => `wealth=${wealth.toPrecision(4)}, futility=${futility.toPrecision(4)}, n=${n}`;
  for (const d of differences) {
    const y = (d + range / 2) / range;
    const mean = (0.5 + sum) / (n + 1), variance = (0.25 + squares) / (n + 1), gap = mean - null0;
    const bet = gap / (variance + gap * gap);
    wealth *= 1 + Math.min(Math.max(bet, 0), 0.5 / null0) * (y - null0);
    futility *= 1 + Math.min(Math.max(-bet, 0), 0.5 / (1 - null0)) * (null0 - y);
    n++; sum += y; squares += (y - (0.5 + sum) / (n + 1)) ** 2;
    if (wealth >= comparisons / alpha) return { accepted: true, final: true, reason: reason() };
    if (futility >= 20) return { accepted: false, final: true, reason: reason() };
  }
  return { accepted: false, final: false, reason: reason() };
}
