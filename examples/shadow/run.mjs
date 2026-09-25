// Shadow evaluation: test a challenger prompt against production logs.
//
// Production already ran the champion — its outputs are in the log.
// Only the challenger makes new calls (here simulated; swap for a real LLM).
// The harness journals everything: crash mid-run → resume, no double calls.
//
// Usage: node examples/shadow/run.mjs

import { readFileSync } from "node:fs";
import { canonical, digest, version, validateVersion } from "teob-mutara";
import { learnerHarness } from "teob-mutara/sqlite";

// --- Data: production log + challenger prompt ---

const log = JSON.parse(readFileSync(new URL("./production-log.json", import.meta.url), "utf8"));
const logById = new Map(log.map((r) => [r.id, r]));

const championPrompt = "Classify the message as cancel or other. Return only the label.";
const challengerPrompt =
  "Return cancel only when the customer explicitly requests cancellation of an " +
  "active order or subscription. Questions about policy, negated requests, and " +
  "refunds alone are other. Return only cancel or other.";

// --- Simulated challenger (replace with real LLM call) ---

const challengerResponses = {
  "req-001": "cancel", "req-002": "other", "req-003": "cancel", "req-004": "other",
  "req-005": "cancel", "req-006": "other", "req-007": "cancel", "req-008": "other",
  "req-009": "other",  "req-010": "other", "req-011": "other", "req-012": "cancel",
};

async function callChallenger(input, _prompt) {
  // Replace this function with a real LLM call:
  //   const res = await llm.complete({ system: prompt, user: input });
  //   return { output: res.text, cost: res.cost };
  const key = log.find((r) => r.input === input)?.id;
  return { output: challengerResponses[key] ?? "other", cost: 0 };
}

// --- Adapter: champion from log, challenger from LLM ---

const source = readFileSync(new URL(import.meta.url), "utf8");
const implementation = { source, championPrompt, challengerPrompt };
canonical(implementation);
const implementationId = digest(implementation);

const plan = {
  initial: version({ prompt: championPrompt }, implementationId),
  rounds: 1,
  log: log.map((r) => r.id),
};

const adapter = {
  implementation,
  recovery: "repeatable",

  validatePlan(p) {
    if (digest(p) !== digest(plan)) throw new Error("Plan changed; use a new experiment ID");
  },
  validateVersion(v) { validateVersion(v, implementationId); },
  limits: () => ({ executions: log.length * 2, cost: 0 }),

  // One candidate: the challenger prompt.
  propose: (champion) => version({ prompt: challengerPrompt }, implementationId, champion.id),

  // Paired jobs: baseline (from log) + candidate (will call LLM).
  jobs(champion, candidate) {
    return log.flatMap((row) => [
      { key: `baseline:${row.id}`, input: { side: "baseline", caseId: row.id, text: row.input }, costLimit: 0 },
      { key: `candidate:${row.id}`, input: { side: "candidate", caseId: row.id, text: row.input }, costLimit: 0 },
    ]);
  },

  async execute(job) {
    if (job.input.side === "baseline") {
      // Champion already ran in production — replay from log, zero cost.
      return { output: logById.get(job.input.caseId).championOutput, cost: 0 };
    }
    // Challenger: real call (or simulated here).
    return callChallenger(job.input.text, challengerPrompt);
  },

  grade(job, receipt) {
    const expected = logById.get(job.input.caseId).label;
    return {
      metrics: { accuracy: Number(receipt.output === expected) },
      data: { predicted: receipt.output, expected },
    };
  },

  assess(runs) {
    const score = (side) => {
      const selected = runs.filter((r) => r.job.input.side === side);
      return selected.reduce((sum, r) => sum + r.observation.metrics.accuracy, 0) / selected.length;
    };
    const baselineAcc = score("baseline");
    const candidateAcc = score("candidate");
    const accepted = candidateAcc > baselineAcc;
    return {
      evaluation: { baseline: baselineAcc, candidate: candidateAcc, n: log.length },
      decision: { accepted, reason: `baseline=${baselineAcc.toFixed(3)} candidate=${candidateAcc.toFixed(3)}` },
    };
  },
};

// --- Run ---

const learner = learnerHarness(":memory:", adapter);
try {
  await learner.start("shadow-v1", plan);
  const result = await learner.wait("shadow-v1");
  const trial = result.trials[0];
  console.log(JSON.stringify({
    evidence: "Simulated challenger; replace callChallenger with real LLM",
    champion: championPrompt,
    challenger: challengerPrompt,
    baselineAccuracy: trial.evaluation.baseline,
    challengerAccuracy: trial.evaluation.candidate,
    n: trial.evaluation.n,
    accepted: trial.accepted,
    reason: trial.reason,
    executions: result.executions,
    cost: result.spent,
  }, null, 2));
} finally {
  await learner.close();
}
