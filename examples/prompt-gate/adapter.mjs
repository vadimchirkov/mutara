// A task-specific adapter, using only public Mutara exports. No prompt generation here.
import { readFileSync } from "node:fs";
import { canonical, digest, version, validateVersion } from "teob-mutara";

const source = readFileSync(new URL(import.meta.url), "utf8");
const labels = ["cancel", "other"];

function validateCases(datasets) {
  const ids = new Set();
  const texts = new Set();
  for (const cases of Object.values(datasets)) {
    if (!Array.isArray(cases) || !cases.length) throw new Error("Each split needs cases");
    for (const row of cases) {
      if (typeof row.id !== "string" || !row.id.trim() || typeof row.text !== "string" ||
          !row.text.trim() || !labels.includes(row.label)) throw new Error("Invalid labeled case");
      const text = row.text.trim().toLowerCase();
      if (ids.has(row.id) || texts.has(text)) throw new Error("Duplicate case or overlapping splits");
      ids.add(row.id);
      texts.add(text);
    }
  }
}

function experiment(bundle, executor, reportOnly) {
  canonical(bundle);
  const { initial, candidates, datasets, provenance } = structuredClone(bundle);
  validateCases(datasets);
  if (typeof provenance !== "object" || provenance === null) throw new Error("Record candidate provenance");
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 100 ||
      [initial, ...candidates].some((prompt) => typeof prompt !== "string" || !prompt.trim())) {
    throw new Error("Provide an initial prompt and 1–100 fixed candidates");
  }
  if (!reportOnly && new Set([initial, ...candidates]).size !== candidates.length + 1) {
    throw new Error("Duplicate prompts");
  }
  const { execute, recovery, costLimit, budget } = executor;
  if (typeof execute !== "function" || !["manual", "repeatable", "idempotent"].includes(recovery) ||
      !Number.isFinite(costLimit) || costLimit < 0 || !Number.isFinite(budget) || budget < 0) {
    throw new Error("Invalid executor or budget");
  }
  const implementation = structuredClone({ source, executor: executor.implementation,
    protocol: { initial, candidates, datasets, provenance, costLimit, budget, reportOnly } });
  canonical(implementation); // Pin model, settings, runner and evaluator dependencies; never credentials.
  const implementationId = digest(implementation);
  const plan = { initial: version({ prompt: initial }, implementationId),
    rounds: candidates.length, candidates, datasets, provenance, costLimit, budget, reportOnly };
  const planId = digest(plan);
  const count = Object.values(datasets).reduce((n, cases) => n + cases.length, 0);
  const casesById = new Map(Object.values(datasets).flat().map((row) => [row.id, row]));

  const adapter = {
    implementation, recovery,
    validatePlan(p) { if (digest(p) !== planId) throw new Error("Prompt experiment changed; use a new ID"); },
    validateVersion(v) {
      validateVersion(v, implementationId);
      if (![initial, ...candidates].includes(v.config.prompt)) throw new Error("Unknown prompt");
    },
    limits: () => ({ executions: candidates.length * 2 * count, cost: budget }),
    propose: (champion, history) => version({ prompt: candidates[history.length] }, implementationId, champion.id),
    jobs(champion, candidate) {
      return Object.entries(datasets).flatMap(([split, cases]) => cases.flatMap((row) =>
        [["baseline", champion], ["candidate", candidate]].map(([side, strategy]) => ({
          key: `${split}:${row.id}:${side}`,
          input: { split, caseId: row.id, side, prompt: strategy.config.prompt, text: row.text },
          costLimit,
        }))));
    },
    execute: (job) => execute({ prompt: job.input.prompt, text: job.input.text },
      { id: job.id, costLimit: job.costLimit }), // No labels, split names or final-test cases reach the runner.
    grade(job, receipt) {
      if (!labels.includes(receipt.output)) throw new Error("Executor must return cancel or other");
      const expected = casesById.get(job.input.caseId).label;
      return { metrics: { accuracy: Number(receipt.output === expected),
        falseCancellation: Number(receipt.output === "cancel" && expected === "other") }, data: null };
    },
    assess(runs) {
      const evaluation = Object.fromEntries(Object.entries(datasets).map(([split, cases]) => {
        const scores = Object.fromEntries(["baseline", "candidate"].map((side) => {
          const selected = runs.filter((r) => r.job.input.split === split && r.job.input.side === side);
          return [side, {
            accuracy: selected.reduce((sum, r) => sum + r.observation.metrics.accuracy, 0) / cases.length,
            falseCancellations: selected.reduce((sum, r) => sum + r.observation.metrics.falseCancellation, 0),
          }];
        }));
        return [split, scores];
      }));
      const accepted = !reportOnly && Object.values(evaluation).every(({ baseline, candidate }) =>
        candidate.accuracy > baseline.accuracy && candidate.falseCancellations <= baseline.falseCancellations);
      return { evaluation, decision: { accepted,
        reason: reportOnly ? "Final test: report only; never promote" : JSON.stringify(evaluation) } };
    },
  };
  return { adapter, plan };
}

export function createPromptGate(bundle, executor) {
  if (Object.keys(bundle.datasets).sort().join(",") !== "training,validation") {
    throw new Error("Selection requires training and validation only");
  }
  return experiment(bundle, executor, false);
}

// Final test never enters selection history. A separate journal makes paid evaluation resumable too.
export function createPromptAudit(selection, test, executor) {
  if (selection.status !== "finished" || selection.plan.reportOnly) throw new Error("Finish selection first");
  validateCases({ ...selection.plan.datasets, test });
  let trainingWinner = selection.plan.initial.config.prompt;
  let best = selection.trials[0].evaluation.training.baseline.accuracy;
  for (const trial of selection.trials) {
    const score = trial.evaluation.training.candidate.accuracy;
    if (score > best) { best = score; trainingWinner = trial.candidate.config.prompt; }
  }
  const promoted = selection.champion.config.prompt;
  return experiment({
    initial: selection.plan.initial.config.prompt,
    candidates: [...new Set([trainingWinner, promoted])], datasets: { test },
    provenance: { selectionId: selection.id, selectionPlan: digest(selection.plan),
      championId: selection.champion.id, trainingWinner, promoted },
  }, executor, true);
}
