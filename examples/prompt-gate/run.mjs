import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { coreId, digest } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";
import { createPromptGate, createPromptAudit } from "./adapter.mjs";
import { loadFixture } from "./fixture.mjs";

const [storage, id, executorPath] = process.argv.slice(2);
if (!storage || !id) throw new Error("Usage: node run.mjs DATABASE EXPERIMENT_ID [EXECUTOR_MODULE]");
const proposals = JSON.parse(readFileSync(new URL("./proposals.json", import.meta.url), "utf8"));
const host = executorPath ? (await import(pathToFileURL(resolve(executorPath)).href)).executor : null;
if (executorPath && !host) throw new Error("Executor module must export executor");

async function run(experimentId, { adapter, plan }) {
  const learner = learnerHarness(storage, adapter);
  try {
    const saved = await learner.startOrResume(experimentId, plan);
    adapter.validatePlan(saved.plan); // A finished journal still must match this exact protocol.
    if (saved.coreId !== coreId || saved.adapterId !== digest({ implementation: adapter.implementation, recovery: adapter.recovery })) {
      throw new Error("Recorded implementation changed; restore it or use a new experiment ID");
    }
    const result = await learner.wait(experimentId);
    return result;
  } finally { await learner.close(); }
}

const selectionData = loadFixture(new URL("./fixtures/selection.json", import.meta.url), proposals);
const selected = await run(id, createPromptGate({ ...proposals, datasets: selectionData.datasets },
  host ?? selectionData.executor));
// Load test cases only after selection is finished. Never feed this report into the proposer.
const testData = loadFixture(new URL("./fixtures/test.json", import.meta.url), proposals);
const audited = await run(`${id}/final-test`, createPromptAudit(selected, testData.datasets.test,
  host ? { ...host, budget: host.budget - selected.spent } : testData.executor));
console.log(JSON.stringify({
  evidence: host ? "Host executor on illustrative cases; not a GEPA comparison" : "Synthetic fixture; NOT measured LLM gains",
  accepted: selected.trials.map((trial) => trial.accepted),
  trainingOnlyPrompt: audited.plan.provenance.trainingWinner,
  promotedPrompt: audited.plan.provenance.promoted,
  finalTest: audited.trials.map((trial) => ({ prompt: trial.candidate.config.prompt, ...trial.evaluation.test })),
  executions: selected.executions + audited.executions,
  spent: selected.spent + audited.spent,
  note: "Final test is report-only. Promotion changes experiment state; host deployment remains explicit.",
}, null, 2));
