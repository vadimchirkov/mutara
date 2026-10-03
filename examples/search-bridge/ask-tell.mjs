// Ask/tell bridge: any searcher with the shape ask(history) -> config becomes a Mutara Adapter.
// history = the journaled (config, value) pairs, oldest first. ask must be a deterministic function of
// history: recovery replays recorded proposals from the journal without calling ask, and a crash between
// ask and the journal write re-asks with the same history, so the searcher needs no state of its own.
// Inside the search every candidate is accepted (the champion is the latest one); pick the release with
// best(state) and gate it separately. No change to src/.
import { canonical, digest, validateVersion, version } from "teob-mutara";

/**
 * implementation: finite JSON pinning the searcher and the evaluator (part of the version identity).
 * ask(history, plan): config. jobs(config, plan, round): Mutara jobs for one trial.
 * validatePlan(plan) adds searcher/evaluator checks. execute/grade as in Adapter; grade must return metrics.value. The trial value is the mean of
 * metrics.value over its jobs. limits(plan) as in Adapter.
 */
export function askTell({ implementation, ask, validateConfig = () => {}, validatePlan = () => {}, jobs, execute, grade, limits }) {
  const implementationId = digest(implementation);
  const strategy = (config, parentId = null) => version(config, implementationId, parentId);
  const checkVersion = (v) => { validateVersion(v, implementationId); validateConfig(v.config); };
  const history = (trials) => trials.map((t) => ({ config: t.candidate.config, value: t.evaluation.value }));
  const adapter = {
    implementation, recovery: "repeatable", limits, execute, grade,
    validateVersion: checkVersion,
    validatePlan(p) { checkVersion(p.initial); validatePlan(p); },
    propose(champion, trials, plan) {
      const past = history(trials);
      const config = ask(past, plan);
      validateConfig(config);
      // A searcher that re-proposes an evaluated point wastes a trial (PSRO lesson); fail loudly instead.
      const key = canonical(config);
      if (past.some((h) => canonical(h.config) === key)) throw new Error(`Searcher repeated a candidate at trial ${past.length}`);
      return strategy(config, champion.id);
    },
    jobs: (_champion, candidate, plan, round) => jobs(candidate.config, plan, round),
    assess(runs) {
      const value = runs.reduce((s, r) => s + r.observation.metrics.value, 0) / runs.length;
      return { evaluation: { value }, decision: { accepted: true, reason: "ask/tell: accept all" } };
    },
  };
  return { adapter, strategy, history: (state) => history(state.trials),
    best: (state) => history(state.trials).reduce((a, b) => (b.value > a.value ? b : a)) };
}
