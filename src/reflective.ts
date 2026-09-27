import { readFileSync } from "node:fs";
import { canonical, digest, version, validateVersion, type Version } from "./version.js";
import { coreId, exceedsCost, type Adapter, type BasePlan, type State } from "./engine.js";
import { learnerHarness } from "./sqlite.js";
import { sequentialDecision } from "./decision.js";

// GEPA-style reflective optimization as a journaled host loop over the core
// learner. The core engine is intentionally untouched: `propose` stays
// synchronous and every LLM call (task execution and reflection) runs as a
// journaled `execute` job with cost reservations, so crash recovery and budget
// accounting keep working. One SQLite file holds single-round experiments:
// `<id>/seed` evaluates the initial prompt, then per round `<id>/propose-r<N>`
// records the reflection, `<id>/screen-r<N>` runs the candidate on the parent's
// reflected failures, and only a passing candidate reaches `<id>/select-r<N>`,
// which evaluates the remaining cases and gates it against the champion's
// recorded outcomes. Re-running with identical options replays finished
// entities without new model calls.
//
// A prompt may be one string or a record of named components. Reflection
// rewrites one component per round, round-robin along each lineage. With
// `maxMerges`, GEPA's system-aware merge combines two frontier descendants of a
// common ancestor that improved different components; merges are deterministic
// text combinations (no model call) and pass the same screen and gate.

const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const reflectiveSource = readFileSync(new URL("reflective" + extension, import.meta.url), "utf8");

export interface ReflectiveCase {
  id: string;
  split: "train" | "validation";
  input: unknown;
  expected: unknown;
}
export interface FinalCase { id: string; input: unknown; expected: unknown }
/** What the task runner sees: never the expected answer. */
export interface TaskCase { id: string; split: "train" | "validation"; input: unknown }
export interface TaskContext { id: string; costLimit: number }
export interface TaskReceipt { output: unknown; cost: number; trace?: string }
export interface CaseGrade { score: number; violation: number; feedback?: unknown }
export interface FailureDetail {
  caseId: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  trace?: string;
  /** Evaluator feedback from `score` (GEPA's textual feedback). */
  feedback?: unknown;
}
export interface PromptScores { trainMean: number; validationMean: number; violations: number }
/** Named prompt components. A plain string prompt is the single component "prompt". */
export type PromptSet = Record<string, string>;
export type PromptInput = string | PromptSet;
export interface ReflectorInput<P extends PromptInput = string> {
  requestId: string;
  round: number;
  /** Component to rewrite; "prompt" when the system is one string. */
  component: string;
  /** Current text of that component. */
  parentPrompt: string;
  /** The whole parent system, for context. */
  parentSystem: P;
  objective: string;
  failures: FailureDetail[];
  parentScores: PromptScores;
}
export interface ReflectorReceipt { text: string; cost: number }
export type Reflector<P extends PromptInput = string> = (input: ReflectorInput<P>) => Promise<ReflectorReceipt>;

export interface ReflectiveOptions<P extends PromptInput = string> {
  id: string;
  storage: string;
  /** Finite JSON pinning task runner, evaluator and reflector model/settings. Never credentials. */
  implementation: unknown;
  /** One prompt string, or up to 20 named components (e.g. `{ system, fewShot, format }`). */
  initialPrompt: P;
  /** Task objective shown to the reflector (GEPA analogue of `objective`). */
  objective: string;
  cases: ReflectiveCase[];
  run: (prompt: P, c: TaskCase, ctx: TaskContext) => Promise<TaskReceipt>;
  score: (receipt: TaskReceipt, c: ReflectiveCase) => CaseGrade;
  reflect: Reflector<P>;
  rounds?: number;
  /** Train cases per reflection; they also form the screening minibatch. */
  maxFailures?: number;
  /** A case scoring at or above this counts as solved and is not reflected on. */
  passScore?: number;
  /** Maximum characters per component. */
  maxPromptChars?: number;
  costLimit?: number;
  reflectionCostLimit?: number;
  budget?: { cost?: number };
  recovery?: "repeatable" | "idempotent" | "manual";
  parentStrategy?: "champion" | "pareto";
  seed?: number;
  /** Retries per failed job (default 3; repeatable/idempotent recovery only). */
  maxRetries?: number;
  /** Model calls of one evaluation stage in flight at once (default 1). Does not change results. */
  concurrency?: number;
  /** GEPA merge attempts; each replaces one reflection round. Default 0. Needs several components to apply. */
  maxMerges?: number;
  /** Held-out cases: never shown to the reflector, report-only audit at the end. */
  finalCases?: FinalCase[];
  /**
   * Paired test of champion vs initial prompt on `finalCases` (the anytime-valid
   * betting test from `decision.ts`). Valid because final cases are fresh and never
   * tuned on, and there is one comparison. `scoreRange` is max − min possible score.
   */
  finalTest?: { scoreRange: number; minimumGain?: number; alpha?: number };
}

export interface SideOutcome { caseId: string; score: number; violation: number; actual: unknown; trace: string | null; feedback: unknown }
export interface SplitScore { mean: number; violations: number }
export interface StageSummary { train: SplitScore | null; validation: SplitScore | null }
export interface StageEvaluation {
  baseline: StageSummary;
  candidate: StageSummary;
  /** Outcomes of the jobs this stage executed; reused outcomes enter only the summaries. */
  executed: { baseline: SideOutcome[]; candidate: SideOutcome[] };
}

interface SideRecord { baselineMean: number; candidateMean: number | null; baselineViolations: number; candidateViolations: number | null }
export interface ReflectiveRoundRecord<P extends PromptInput = string> {
  round: number;
  kind: "reflect" | "merge";
  /** Rewritten component; null for merges. */
  component: string | null;
  parentPrompt: P;
  /** Second parent of a merge; null for reflections. */
  mergeParent: P | null;
  /** The gate baseline: champion at the start of the round. */
  championPrompt: P;
  candidatePrompt: P;
  screened: boolean;
  evaluated: boolean;
  accepted: boolean;
  reason: string;
  train: SideRecord;
  validation: SideRecord;
  reflectionCost: number;
  selectionSpent: number;
  executions: number;
}
export interface FrontierEntry<T = string> extends PromptScores { prompt: T; wins: number }
export interface ReflectiveResult<P extends PromptInput = string> {
  id: string;
  champion: P;
  initial: P;
  roundsCompleted: number;
  stopReason: string | null;
  history: ReflectiveRoundRecord<P>[];
  frontier: FrontierEntry<P>[];
  executions: number;
  spent: number;
  reflectionCalls: number;
  merges: number;
  finalAudit: {
    baselineMean: number;
    championMean: number;
    baselineViolations: number;
    championViolations: number;
    cases: number;
    /** Present when `finalTest` is set: accepted only if the gain is significant and violations did not grow. */
    test: { accepted: boolean; reason: string } | null;
  } | null;
}

type PromptVersion = Version<{ prompts: PromptSet }>;
interface CaseScore { caseId: string; score: number; violation: number }
type Stage = "seed" | "screen" | "merge-screen" | "select" | "audit";
interface EvaluationPlan extends BasePlan<PromptVersion> {
  stage: Stage;
  candidatePrompts: PromptSet;
  cases: ReflectiveCase[];
  /** Case IDs to execute per side; everything else comes from `known`. */
  runs: { baseline: string[]; candidate: string[] };
  known: { baseline: CaseScore[]; candidate: CaseScore[] };
  costLimit: number;
}
type CarrierVersion = Version<{ slot: number }>;
interface ProposalPlan extends BasePlan<CarrierVersion> {
  requestId: string;
  component: string;
  parentSystem: PromptSet;
  objective: string;
  failures: FailureDetail[];
  parentScores: PromptScores;
  reflectionCostLimit: number;
  maxPromptChars: number;
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finiteJson(value: unknown, what: string): void {
  try { canonical(value); } catch { throw new Error(`Invalid ${what}: must be finite JSON`); }
}

/** Pure reflection-prompt builder (GEPA mutation prompt). Train failures only; validation/final truth never enters. */
export function buildReflectionPrompt(
  objective: string,
  parentPrompt: string,
  failures: FailureDetail[],
  parentScores: PromptScores,
  /** For multi-component systems: the component being rewritten and the whole system. */
  context?: { component: string; system: PromptSet },
): string {
  const others = context ? Object.entries(context.system).filter(([k]) => k !== context.component) : [];
  const lines = [
    "You are an expert prompt engineer improving a system prompt.",
    `Objective: ${objective}`,
    "",
  ];
  if (others.length) {
    lines.push(`The system has several prompt components; rewrite only "${context!.component}". Other components, for context:`);
    for (const [k, text] of others) lines.push(`<component name=${JSON.stringify(k)}>`, text, "</component>");
    lines.push("", `Current "${context!.component}" component:`);
  } else {
    lines.push("Current system prompt:");
  }
  lines.push(
    "<prompt>",
    parentPrompt,
    "</prompt>",
    "",
    `Current train score: ${parentScores.trainMean} (validation: ${parentScores.validationMean}, violations: ${parentScores.violations}).`,
    "",
    `Diagnose the flaw behind these ${failures.length} failing train cases, then rewrite the prompt to fix them without regressing on other cases:`,
  );
  failures.forEach((f, i) => {
    lines.push(`--- Case ${i + 1} (${f.caseId}) ---`);
    lines.push(`Input: ${JSON.stringify(f.input)}`);
    lines.push(`Expected: ${JSON.stringify(f.expected)}`);
    lines.push(`Model produced: ${JSON.stringify(f.actual)}`);
    if (f.feedback !== undefined && f.feedback !== null) {
      lines.push(`Evaluator feedback: ${typeof f.feedback === "string" ? f.feedback : JSON.stringify(f.feedback)}`);
    }
    if (f.trace) lines.push(`Reasoning trace: ${f.trace.slice(0, 1500)}`);
  });
  lines.push("", others.length
    ? `Return ONLY the improved text of the "${context!.component}" component, with no explanation or formatting.`
    : "Return ONLY the improved system prompt text, with no explanation or formatting.");
  return lines.join("\n");
}

function summarize(scores: CaseScore[], cases: ReflectiveCase[]): StageSummary {
  const split = (name: "train" | "validation"): SplitScore | null => {
    const ids = new Set(cases.filter((c) => c.split === name).map((c) => c.id));
    const s = scores.filter((o) => ids.has(o.caseId));
    return s.length ? { mean: s.reduce((n, o) => n + o.score, 0) / s.length, violations: s.reduce((n, o) => n + o.violation, 0) } : null;
  };
  return { train: split("train"), validation: split("validation") };
}

function promptScores(outcomes: CaseScore[], cases: ReflectiveCase[]): PromptScores {
  const { train, validation } = summarize(outcomes, cases);
  return { trainMean: train?.mean ?? 0, validationMean: validation?.mean ?? 0,
    violations: (train?.violations ?? 0) + (validation?.violations ?? 0) };
}

/**
 * GEPA per-case Pareto frontier over validation cases: prompts that reach the
 * best score on at least one case and are not dominated case-by-case. `wins`
 * counts the cases each keeps a best score on; it weights parent sampling.
 */
export function paretoFrontier<T>(evaluations: { prompt: T; outcomes: CaseScore[] }[], cases: ReflectiveCase[]): FrontierEntry<T>[] {
  const ids = cases.filter((c) => c.split === "validation").map((c) => c.id);
  const table = evaluations.map((e) => {
    const byCase = new Map(e.outcomes.map((o) => [o.caseId, o.score]));
    return { e, s: ids.map((id) => byCase.get(id) ?? -Infinity) };
  });
  const best = ids.map((_, i) => Math.max(...table.map((t) => t.s[i]!)));
  const winners = table.filter((t) => t.s.some((v, i) => v === best[i]));
  const kept = winners.filter((t) => !winners.some((o) => o !== t &&
    o.s.every((v, i) => v >= t.s[i]!) && o.s.some((v, i) => v > t.s[i]!)));
  return kept
    .map((t) => ({ prompt: t.e.prompt, ...promptScores(t.e.outcomes, cases), wins: t.s.filter((v, i) => v === best[i]).length }))
    .sort((a, b) => b.wins - a.wins || b.validationMean - a.validationMean ||
      (canonical(a.prompt) < canonical(b.prompt) ? -1 : canonical(a.prompt) > canonical(b.prompt) ? 1 : 0));
}

/** Seeded parent sample weighted by per-case wins. */
export function selectParent<T>(frontier: FrontierEntry<T>[], seed: number, round: number): T {
  if (!frontier.length) throw new Error("Empty frontier");
  let r = rng(seed + round * 0x9e3779b9)() * frontier.reduce((n, e) => n + e.wins, 0);
  for (const e of frontier) {
    r -= e.wins;
    if (r < 0) return e.prompt;
  }
  return frontier[frontier.length - 1]!.prompt;
}

function validateCases(cases: ReflectiveCase[]): void {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 500) throw new Error("Provide 2–500 evaluation cases");
  const ids = new Set<string>();
  let train = 0, validation = 0;
  for (const c of cases) {
    if (typeof c.id !== "string" || !c.id.trim()) throw new Error("Each case needs a nonempty string id");
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
    if (c.split !== "train" && c.split !== "validation") throw new Error(`Case ${c.id} needs split train or validation`);
    if (c.split === "train") train++; else validation++;
    finiteJson(c.input, `input of case ${c.id}`);
    finiteJson(c.expected, `expected of case ${c.id}`);
  }
  if (!train || !validation) throw new Error("Selection needs at least one train and one validation case");
}

function validateOptions<P extends PromptInput>(opts: ReflectiveOptions<P>) {
  if (typeof opts.id !== "string" || !opts.id.trim()) throw new Error("An experiment ID is required");
  if (typeof opts.storage !== "string" || !opts.storage) throw new Error("A storage path is required");
  finiteJson(opts.implementation, "implementation");
  const rounds = opts.rounds ?? 10;
  const maxFailures = opts.maxFailures ?? 5;
  const passScore = opts.passScore ?? 1;
  const maxPromptChars = opts.maxPromptChars ?? 8000;
  const costLimit = opts.costLimit ?? 0;
  const reflectionCostLimit = opts.reflectionCostLimit ?? 0;
  const budgetCost = opts.budget?.cost ?? 0;
  const seed = opts.seed ?? 7919;
  const maxRetries = opts.maxRetries ?? 3;
  const maxMerges = opts.maxMerges ?? 0;
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("rounds must be between 1 and 100");
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 20) throw new Error("maxFailures must be between 1 and 20");
  if (!Number.isFinite(passScore)) throw new Error("passScore must be a finite number");
  if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1 || maxPromptChars > 64000) throw new Error("maxPromptChars out of range");
  const initial: unknown = opts.initialPrompt;
  const texts = typeof initial === "string" ? [initial]
    : initial && typeof initial === "object" && Object.getPrototypeOf(initial) === Object.prototype ? Object.values(initial) : [];
  if (!texts.length || texts.length > 20 || texts.some((t) => typeof t !== "string" || !t.trim() || t.length > maxPromptChars) ||
      (typeof initial !== "string" && Object.keys(initial as object).some((k) => !k.trim() || k.length > 100))) {
    throw new Error("initialPrompt must be a nonempty string, or 1–20 named nonempty components, within maxPromptChars");
  }
  if (typeof opts.objective !== "string" || !opts.objective.trim() || opts.objective.length > 4000) {
    throw new Error("objective must be a nonempty string (max 4000 chars)");
  }
  if (!Number.isFinite(costLimit) || costLimit < 0 || !Number.isFinite(reflectionCostLimit) || reflectionCostLimit < 0) {
    throw new Error("Invalid cost limits");
  }
  if (!Number.isFinite(budgetCost) || budgetCost < 0) throw new Error("Invalid cost budget");
  if (!Number.isSafeInteger(seed)) throw new Error("Invalid seed");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error("maxRetries must be between 0 and 10");
  if (!Number.isSafeInteger(maxMerges) || maxMerges < 0 || maxMerges > 100) throw new Error("maxMerges must be between 0 and 100");
  const finalTest = opts.finalTest === undefined ? null
    : { scoreRange: opts.finalTest.scoreRange, minimumGain: opts.finalTest.minimumGain ?? 0, alpha: opts.finalTest.alpha ?? 0.05 };
  if (finalTest && (!opts.finalCases || !Number.isFinite(finalTest.scoreRange) || finalTest.scoreRange <= 0 ||
      !Number.isFinite(finalTest.minimumGain) || finalTest.minimumGain < 0 || !(finalTest.alpha > 0 && finalTest.alpha < 1))) {
    throw new Error("finalTest needs finalCases, a positive scoreRange, minimumGain >= 0 and alpha in (0, 1)");
  }
  const recovery = opts.recovery ?? "manual";
  if (!["repeatable", "idempotent", "manual"].includes(recovery)) throw new Error("Invalid recovery mode");
  const parentStrategy = opts.parentStrategy ?? "champion";
  if (parentStrategy !== "champion" && parentStrategy !== "pareto") throw new Error("Invalid parent strategy");
  if (typeof opts.run !== "function" || typeof opts.score !== "function" || typeof opts.reflect !== "function") {
    throw new Error("run, score and reflect callbacks are required");
  }
  validateCases(opts.cases);
  if (opts.finalCases !== undefined) {
    if (!Array.isArray(opts.finalCases) || !opts.finalCases.length || opts.finalCases.length > 500) {
      throw new Error("finalCases must be a nonempty list up to 500 cases");
    }
    const ids = new Set(opts.cases.map((c) => c.id));
    for (const c of opts.finalCases) {
      if (typeof c.id !== "string" || !c.id.trim()) throw new Error("Each final case needs a nonempty string id");
      if (ids.has(c.id)) throw new Error(`Final case ${c.id} overlaps selection cases; keep final held-out data disjoint`);
      ids.add(c.id);
      finiteJson(c.input, `input of final case ${c.id}`);
      finiteJson(c.expected, `expected of final case ${c.id}`);
    }
  }
  // Seed evaluation plus one round: reflection, then at most one candidate job per case (screen + select).
  if (exceedsCost(reflectionCostLimit + 2 * opts.cases.length * costLimit, budgetCost)) {
    throw new Error("Budget cannot reserve one round (seed evaluation + reflection + candidate jobs)");
  }
  return { rounds, maxFailures, passScore, maxPromptChars, costLimit, reflectionCostLimit, budgetCost, seed, maxRetries, maxMerges,
    recovery, parentStrategy, finalTest };
}

function adapterIdOf(adapter: { implementation: unknown; recovery: string }): string {
  return digest({ implementation: adapter.implementation, recovery: adapter.recovery });
}

/** Proposal experiment: the reflection LLM call is one journaled `execute` job. */
function createProposalExperiment<P extends PromptInput>(args: {
  implementation: unknown;
  requestId: string;
  round: number;
  component: string;
  parentSystem: PromptSet;
  unwrap: (prompts: PromptSet) => P;
  objective: string;
  failures: FailureDetail[];
  parentScores: PromptScores;
  reflectionCostLimit: number;
  maxPromptChars: number;
  reflect: Reflector<P>;
  recovery: "repeatable" | "idempotent" | "manual";
}): { adapter: Adapter<CarrierVersion, ProposalPlan, { text: string }>; plan: ProposalPlan } {
  const { implementation, requestId, round, component, parentSystem, unwrap, objective, failures, parentScores,
    reflectionCostLimit, maxPromptChars, reflect, recovery } = args;
  const implId = digest(implementation);
  const plan: ProposalPlan = {
    initial: version({ slot: round }, implId),
    rounds: 1,
    requestId, component, parentSystem: { ...parentSystem }, objective,
    failures: structuredClone(failures),
    parentScores: { ...parentScores },
    reflectionCostLimit, maxPromptChars,
  };
  const planId = digest(plan);
  const adapter: Adapter<CarrierVersion, ProposalPlan, { text: string }> = {
    implementation, recovery,
    validatePlan(p) { if (digest(p) !== planId) throw new Error("Proposal plan changed; use a new experiment ID"); },
    validateVersion(v) {
      validateVersion(v, implId);
      if (!Number.isSafeInteger(v.config.slot)) throw new Error("Invalid proposal slot");
    },
    limits: () => ({ executions: 1, cost: reflectionCostLimit }),
    propose: (champion) => version({ slot: round }, implId, champion.id),
    jobs: () => [{ key: "reflect", input: { requestId, component, parentSystem, failures }, costLimit: reflectionCostLimit }],
    execute: async (job) => {
      const input = job.input as { requestId: unknown; component: string; parentSystem: PromptSet };
      const receipt = await reflect({
        requestId: String(input.requestId),
        round,
        component: input.component,
        parentPrompt: String(input.parentSystem[input.component]),
        parentSystem: unwrap(input.parentSystem),
        objective,
        failures: structuredClone(failures),
        parentScores: { ...parentScores },
      });
      if (typeof receipt.text !== "string" || !receipt.text.trim() || receipt.text.length > maxPromptChars) {
        throw new Error("Reflector must return a nonempty prompt within maxPromptChars");
      }
      if (!Number.isFinite(receipt.cost) || receipt.cost < 0 || exceedsCost(receipt.cost, reflectionCostLimit)) {
        throw new Error("Invalid reflection receipt or cost exceeded its reservation");
      }
      return { output: { text: receipt.text, requestId }, cost: receipt.cost };
    },
    grade: (_job, receipt) => {
      const output = receipt.output as { text?: unknown };
      if (typeof output?.text !== "string" || !output.text.trim() || output.text.length > maxPromptChars) {
        throw new Error("Invalid reflection output");
      }
      return { metrics: { valid: 1 }, data: null };
    },
    assess: (runs) => {
      const text = (runs[0]!.receipt!.output as { text: string }).text;
      return { evaluation: { text }, decision: { accepted: true, reason: "proposal recorded" } };
    },
  };
  return { adapter, plan };
}

/**
 * Evaluation experiment: runs the listed baseline/candidate jobs, merges them
 * with reused outcomes from `known`, and decides by stage. Seed and audit are
 * report-only; screen needs a strict train gain on its minibatch (a merge only
 * has to match its better parent where the parents disagree); select needs a
 * strict mean gain on both splits without more violations on either.
 */
function createEvaluationExperiment<P extends PromptInput>(args: {
  implementation: unknown;
  plan: EvaluationPlan;
  run: ReflectiveOptions<P>["run"];
  score: ReflectiveOptions<P>["score"];
  unwrap: (prompts: PromptSet) => P;
  recovery: "repeatable" | "idempotent" | "manual";
}): Adapter<PromptVersion, EvaluationPlan, StageEvaluation> {
  const { implementation, plan, run, score, unwrap, recovery } = args;
  const implId = digest(implementation);
  const validPrompts = (prompts: unknown) => !!prompts && typeof prompts === "object" &&
    Object.values(prompts).length > 0 && Object.values(prompts).every((t) => typeof t === "string" && t.trim());
  if (!validPrompts(plan.candidatePrompts)) throw new Error("Candidate prompt must be nonempty");
  const planId = digest(plan);
  const byId = new Map(plan.cases.map((c) => [c.id, c]));
  const caseOf = (id: string) => {
    const found = byId.get(id);
    if (!found) throw new Error(`Unknown case ${id}`);
    return found;
  };
  return {
    implementation, recovery,
    validatePlan(p) { if (digest(p) !== planId) throw new Error("Evaluation plan changed; use a new experiment ID"); },
    validateVersion(v) {
      validateVersion(v, implId);
      if (!validPrompts(v.config.prompts)) throw new Error("Unknown prompt version");
    },
    limits: (p) => {
      const n = p.runs.baseline.length + p.runs.candidate.length;
      return { executions: n, cost: n * p.costLimit };
    },
    propose: (champion, history, p) => {
      if (history.length) throw new Error("Single-round evaluation cannot propose twice");
      return version({ prompts: p.candidatePrompts }, implId, champion.id);
    },
    jobs: (champion, candidate, p) => (["baseline", "candidate"] as const).flatMap((side) =>
      p.runs[side].map((caseId) => ({
        key: `${side}:${caseId}`,
        input: { caseId, side, prompts: (side === "candidate" ? candidate : champion).config.prompts },
        costLimit: p.costLimit,
      }))),
    execute: async (job) => {
      const { caseId, prompts } = job.input as { caseId: string; prompts: PromptSet };
      const c = caseOf(String(caseId));
      // Evaluation truth never reaches the task runner: only id, split and input.
      const receipt = await run(unwrap(prompts), { id: c.id, split: c.split, input: structuredClone(c.input) },
        { id: job.id, costLimit: job.costLimit });
      finiteJson(receipt.output, "task output");
      if (receipt.trace !== undefined && typeof receipt.trace !== "string") throw new Error("Task trace must be a string");
      if (!Number.isFinite(receipt.cost) || receipt.cost < 0) throw new Error("Invalid task cost");
      return { output: { result: receipt.output, trace: receipt.trace ?? null }, cost: receipt.cost };
    },
    grade: (job, receipt) => {
      const c = caseOf(String((job.input as { caseId: string }).caseId));
      const output = receipt.output as { result?: unknown; trace?: string | null };
      const graded = score(
        { output: output?.result, cost: receipt.cost, ...(typeof output?.trace === "string" ? { trace: output.trace } : {}) },
        c,
      );
      if (!Number.isFinite(graded.score) || !Number.isFinite(graded.violation) || graded.violation < 0) {
        throw new Error("Score and nonnegative violation must be finite numbers");
      }
      finiteJson(graded.feedback ?? null, "grade feedback");
      return { metrics: { score: graded.score, violation: graded.violation }, data: graded.feedback ?? null };
    },
    assess: (runs, p) => {
      const executed: StageEvaluation["executed"] = { baseline: [], candidate: [] };
      for (const r of runs) {
        const { caseId, side } = r.job.input as { caseId: string; side: "baseline" | "candidate" };
        const output = r.receipt!.output as { result: unknown; trace: string | null };
        executed[side].push({ caseId, score: r.observation!.metrics.score!, violation: r.observation!.metrics.violation!,
          actual: output.result, trace: output.trace, feedback: r.observation!.data });
      }
      const baseline = summarize([...p.known.baseline, ...executed.baseline], p.cases);
      const candidate = summarize([...p.known.candidate, ...executed.candidate], p.cases);
      const beats = (split: "train" | "validation", strict = true) => {
        const c = candidate[split], b = baseline[split];
        return !!c && !!b && (strict ? c.mean > b.mean : c.mean >= b.mean) && c.violations <= b.violations;
      };
      const accepted = p.stage === "screen" ? beats("train") : p.stage === "merge-screen" ? beats("train", false)
        : p.stage === "select" ? beats("train") && beats("validation") : false;
      const reason = p.stage === "seed" || p.stage === "audit" ? "Report only; never promote" : JSON.stringify({ baseline, candidate });
      return { evaluation: { baseline, candidate, executed }, decision: { accepted, reason } };
    },
  };
}

const STAGE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

async function runEntity<V extends { id: string; parentId: string | null }, P extends BasePlan<V>, E>(
  storage: string,
  entityId: string,
  adapter: Adapter<V, P, E>,
  plan: P,
  recovery: "repeatable" | "idempotent" | "manual",
  maxRetries: number,
  category: string,
  concurrency = 1,
): Promise<State<V, P, E>> {
  // The harness default (5 min without journal progress) is too short for LLM jobs; hung
  // calls must be bounded by the task runner itself.
  const h = learnerHarness(storage, adapter, { category, concurrency, askTimeoutMs: STAGE_TIMEOUT_MS });
  try {
    const saved = await h.startOrResume(entityId, plan);
    if (saved.coreId !== coreId || saved.adapterId !== adapterIdOf(adapter) ||
        canonical(saved.plan) !== canonical(plan)) {
      throw new Error(`Recorded implementation or plan changed for ${entityId}; use a new experiment ID`);
    }
    const attempts = new Map<string, number>();
    for (;;) {
      try {
        return await h.wait(entityId, STAGE_TIMEOUT_MS);
      } catch (error) {
        if (recovery === "manual") throw error;
        const s = await h.state(entityId);
        if (s.status !== "blocked") throw error;
        // Several jobs may be blocked at once; retry each of them up to maxRetries times.
        if (!s.unresolved?.length) throw error;
        for (const jobId of s.unresolved) attempts.set(jobId, (attempts.get(jobId) ?? 0) + 1);
        if (s.unresolved.some((jobId) => attempts.get(jobId)! > maxRetries)) throw error;
        for (const jobId of s.unresolved) await h.send(entityId, { tag: "retry", jobId });
      }
    }
  } finally {
    await h.close();
  }
}

async function labelled<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reflective GEPA-style optimization with journaled proposals, minibatch screening, merges and gated promotion. */
export async function optimizeReflective<P extends PromptInput = string>(opts: ReflectiveOptions<P>): Promise<ReflectiveResult<P>> {
  const { rounds, maxFailures, passScore, maxPromptChars, costLimit, reflectionCostLimit, budgetCost,
    seed, maxRetries, maxMerges, recovery, parentStrategy, finalTest } = validateOptions(opts);
  const single = typeof opts.initialPrompt === "string";
  const initialSet: PromptSet = single ? { prompt: opts.initialPrompt as string } : { ...(opts.initialPrompt as PromptSet) };
  const components = Object.keys(initialSet).sort();
  const unwrap = (prompts: PromptSet) => (single ? prompts.prompt : { ...prompts }) as P;
  const keyOf = (prompts: PromptSet) => canonical(prompts);
  const settingsPin = { objective: opts.objective, rounds, maxFailures, passScore, maxPromptChars, costLimit,
    reflectionCostLimit, recovery, parentStrategy, seed, maxMerges, casesId: digest(opts.cases),
    finalCasesId: opts.finalCases ? digest(opts.finalCases) : null };
  const proposalImplementation = { module: reflectiveSource, role: "reflective-proposal-v3", executor: opts.implementation, settings: settingsPin };
  const evaluationImplementation = { module: reflectiveSource, role: "reflective-evaluation-v3", executor: opts.implementation, settings: settingsPin };
  const implId = digest(evaluationImplementation);

  const order = new Map(opts.cases.map((c, i) => [c.id, i]));
  const casesById = new Map(opts.cases.map((c) => [c.id, c]));
  const trainIds = opts.cases.filter((c) => c.split === "train").map((c) => c.id);
  const sorted = (outcomes: SideOutcome[]) => [...outcomes].sort((a, b) => order.get(a.caseId)! - order.get(b.caseId)!);
  const scoreOf = (o: SideOutcome): CaseScore => ({ caseId: o.caseId, score: o.score, violation: o.violation });
  // Keyed by canonical prompt set, in evaluation order: full outcomes, texts, recorded versions,
  // lineage parents (two for merges) and the next component each lineage rewrites.
  const evals = new Map<string, SideOutcome[]>();
  const sets = new Map<string, PromptSet>();
  const versions = new Map<string, PromptVersion>();
  const parentsOf = new Map<string, string[]>();
  const nextComponent = new Map<string, number>();
  const history: ReflectiveRoundRecord<P>[] = [];
  const initialKey = keyOf(initialSet);
  const seen = new Set<string>([initialKey]);
  let executions = 0;
  let spent = 0;
  let reflectionCalls = 0;
  let merges = 0;
  let mergeDue = false;
  let stopReason: string | null = null;

  const evaluate = (entityId: string, plan: Omit<EvaluationPlan, "rounds" | "costLimit">) => {
    const full: EvaluationPlan = { ...plan, rounds: 1, costLimit };
    const adapter = createEvaluationExperiment({ implementation: evaluationImplementation, plan: full,
      run: opts.run, score: opts.score, unwrap, recovery });
    return runEntity(opts.storage, entityId, adapter, full, recovery, maxRetries, "reflective-evaluation", opts.concurrency).then((state) => {
      spent += state.spent;
      executions += state.executions;
      return state.trials[0]!;
    });
  };
  const scoresOf = (key: string) => promptScores(evals.get(key)!, opts.cases);
  const scoreOn = (key: string, id: string) => evals.get(key)!.find((o) => o.caseId === id)!.score;
  const failuresOf = (key: string): FailureDetail[] => evals.get(key)!
    .filter((o) => casesById.get(o.caseId)!.split === "train" && o.score < passScore)
    .sort((a, b) => a.score - b.score || order.get(a.caseId)! - order.get(b.caseId)!)
    .slice(0, maxFailures)
    .map((o) => {
      const c = casesById.get(o.caseId)!;
      return { caseId: o.caseId, input: c.input, expected: c.expected, actual: o.actual,
        ...(o.trace ? { trace: o.trace } : {}), ...(o.feedback !== null ? { feedback: o.feedback } : {}) };
    });
  const frontier = () => paretoFrontier([...evals].map(([prompt, outcomes]) => ({ prompt, outcomes })), opts.cases);
  const ancestorsOf = (key: string) => {
    const out = new Set<string>();
    const stack = [key];
    while (stack.length) {
      const k = stack.pop()!;
      if (out.has(k)) continue;
      out.add(k);
      stack.push(...(parentsOf.get(k) ?? []));
    }
    return out;
  };
  // GEPA merge: two frontier prompts, neither descending from the other, whose most recent
  // common ancestor each improved on a different component. Components changed by both
  // come from the higher-ranked frontier entry. Screened where the two disagree on train.
  const findMerge = (round: number) => {
    const front = frontier().map((e) => e.prompt);
    const found: { a: string; b: string; merged: PromptSet; screenIds: string[] }[] = [];
    for (let i = 0; i < front.length; i++) {
      for (let j = i + 1; j < front.length; j++) {
        const a = front[i]!, b = front[j]!;
        const up = [ancestorsOf(a), ancestorsOf(b)] as const;
        if (up[0].has(b) || up[1].has(a)) continue;
        const common = [...evals.keys()].filter((k) => up[0].has(k) && up[1].has(k)).reverse();
        for (const c of common) {
          const [sa, sb, sc] = [sets.get(a)!, sets.get(b)!, sets.get(c)!];
          const onlyA = components.filter((k) => sa[k] !== sc[k] && sb[k] === sc[k]);
          const onlyB = components.filter((k) => sb[k] !== sc[k] && sa[k] === sc[k]);
          if (!onlyA.length || !onlyB.length) continue;
          const merged = Object.fromEntries(components.map((k) => [k, onlyB.includes(k) ? sb[k]! : sa[k]!]));
          const screenIds = trainIds.filter((id) => scoreOn(a, id) !== scoreOn(b, id)).slice(0, maxFailures);
          if (!seen.has(keyOf(merged)) && screenIds.length) found.push({ a, b, merged, screenIds });
          break;
        }
      }
    }
    return found.length ? found[Math.floor(rng(seed + round * 0x9e3779b9 + 1)() * found.length)]! : null;
  };

  // Seed: evaluate the initial prompt once so round 0 reflects on real failures.
  const initialVersion = version({ prompts: initialSet }, implId, null);
  const seedTrial = await labelled("Seed evaluation", () => evaluate(`${opts.id}/seed`, {
    initial: initialVersion, stage: "seed", candidatePrompts: initialSet, cases: opts.cases,
    runs: { baseline: opts.cases.map((c) => c.id), candidate: [] }, known: { baseline: [], candidate: [] } }));
  evals.set(initialKey, sorted(seedTrial.evaluation.executed.baseline));
  sets.set(initialKey, initialSet);
  versions.set(initialKey, initialVersion);
  let champion = initialKey;

  for (let round = 0; round < rounds; round++) {
    // Screen and select together run the candidate at most once per case.
    if (exceedsCost(spent + reflectionCostLimit + opts.cases.length * costLimit, budgetCost)) {
      stopReason = `Budget exhausted before round ${round}`;
      break;
    }
    const championKey = champion;
    const championSummary = summarize(evals.get(championKey)!, opts.cases);
    const merge = mergeDue && merges < maxMerges ? findMerge(round) : null;
    mergeDue = false;
    let parentKey: string, candidate: PromptSet, screenIds: string[], screenBaseline: string;
    let component: string | null = null;
    let reflection = { spent: 0, executions: 0 };
    if (merge) {
      merges += 1;
      parentKey = merge.a;
      candidate = merge.merged;
      screenIds = merge.screenIds;
      const sum = (key: string) => screenIds.reduce((n, id) => n + scoreOn(key, id), 0);
      screenBaseline = sum(merge.b) > sum(merge.a) ? merge.b : merge.a;
    } else {
      const eligible = parentStrategy === "pareto" ? frontier().filter((e) => failuresOf(e.prompt).length) : [];
      const picked = eligible.length ? selectParent(eligible, seed, round) : failuresOf(champion).length ? champion : null;
      if (picked === null) {
        stopReason = `No train failures below passScore left before round ${round}`;
        break;
      }
      parentKey = picked;
      const slot = nextComponent.get(parentKey) ?? 0;
      nextComponent.set(parentKey, slot + 1);
      component = components[slot % components.length]!;
      const failures = failuresOf(parentKey);
      const proposal = createProposalExperiment({
        implementation: proposalImplementation,
        requestId: `${opts.id}/reflect/${round}`, round, component, parentSystem: sets.get(parentKey)!, unwrap,
        objective: opts.objective, failures, parentScores: scoresOf(parentKey), reflectionCostLimit, maxPromptChars,
        reflect: opts.reflect, recovery,
      });
      const proposalState = await labelled(`Round ${round} proposal`, () => runEntity(opts.storage, `${opts.id}/propose-r${round}`,
        proposal.adapter, proposal.plan, recovery, maxRetries, "reflective-proposal"));
      spent += proposalState.spent;
      executions += proposalState.executions;
      reflectionCalls += 1;
      reflection = { spent: proposalState.spent, executions: proposalState.executions };
      candidate = { ...sets.get(parentKey)!, [component]: proposalState.trials[0]!.evaluation.text };
      screenIds = failures.map((f) => f.caseId);
      screenBaseline = parentKey;
    }
    const candidateKey = keyOf(candidate);
    const spentBefore = spent, executionsBefore = executions;
    const record = (fields: Pick<ReflectiveRoundRecord, "screened" | "evaluated" | "accepted" | "reason">): ReflectiveRoundRecord<P> => ({
      round, kind: merge ? "merge" : "reflect", component, parentPrompt: unwrap(sets.get(parentKey)!),
      mergeParent: merge ? unwrap(sets.get(merge.b)!) : null, championPrompt: unwrap(sets.get(championKey)!),
      candidatePrompt: unwrap(candidate), ...fields,
      train: { baselineMean: championSummary.train!.mean, candidateMean: null,
        baselineViolations: championSummary.train!.violations, candidateViolations: null },
      validation: { baselineMean: championSummary.validation!.mean, candidateMean: null,
        baselineViolations: championSummary.validation!.violations, candidateViolations: null },
      reflectionCost: reflection.spent, selectionSpent: spent - spentBefore,
      executions: reflection.executions + executions - executionsBefore,
    });

    if (seen.has(candidateKey)) {
      history.push(record({ screened: false, evaluated: false, accepted: false, reason: "Duplicate proposal; skipped evaluation" }));
      continue;
    }
    seen.add(candidateKey);
    if (exceedsCost(spent + opts.cases.length * costLimit, budgetCost)) {
      stopReason = `Budget exhausted after round ${round} proposal`;
      history.push(record({ screened: false, evaluated: false, accepted: false, reason: stopReason }));
      break;
    }

    // Screen against recorded outcomes: the parent's reflected failures (GEPA minibatch
    // check), or for a merge the train cases where its parents disagree.
    const screen = await labelled(`Round ${round} screen`, () => evaluate(`${opts.id}/screen-r${round}`, {
      initial: versions.get(screenBaseline)!, stage: merge ? "merge-screen" : "screen", candidatePrompts: candidate,
      cases: screenIds.map((id) => casesById.get(id)!), runs: { baseline: [], candidate: screenIds },
      known: { baseline: evals.get(screenBaseline)!.filter((o) => screenIds.includes(o.caseId)).map(scoreOf), candidate: [] } }));
    if (!screen.accepted) {
      history.push(record({ screened: true, evaluated: false, accepted: false, reason: `Screen rejected: ${screen.reason}` }));
      continue;
    }

    // Full gate against the champion; screened outcomes are reused, not rerun.
    const screened = screen.evaluation.executed.candidate;
    const select = await labelled(`Round ${round} selection`, () => evaluate(`${opts.id}/select-r${round}`, {
      initial: versions.get(championKey)!, stage: "select", candidatePrompts: candidate, cases: opts.cases,
      runs: { baseline: [], candidate: opts.cases.map((c) => c.id).filter((id) => !screenIds.includes(id)) },
      known: { baseline: evals.get(championKey)!.map(scoreOf), candidate: screened.map(scoreOf) } }));
    evals.set(candidateKey, sorted([...screened, ...select.evaluation.executed.candidate]));
    sets.set(candidateKey, candidate);
    versions.set(candidateKey, select.candidate);
    parentsOf.set(candidateKey, merge ? [merge.a, merge.b] : [parentKey]);
    nextComponent.set(candidateKey, merge ? 0 : components.indexOf(component!) + 1);
    mergeDue = true;
    if (select.accepted) champion = candidateKey;
    const { baseline, candidate: side } = select.evaluation;
    const entry = record({ screened: true, evaluated: true, accepted: select.accepted, reason: select.reason });
    entry.train = { baselineMean: baseline.train!.mean, candidateMean: side.train!.mean,
      baselineViolations: baseline.train!.violations, candidateViolations: side.train!.violations };
    entry.validation = { baselineMean: baseline.validation!.mean, candidateMean: side.validation!.mean,
      baselineViolations: baseline.validation!.violations, candidateViolations: side.validation!.violations };
    history.push(entry);
  }

  let finalAudit: ReflectiveResult["finalAudit"] = null;
  if (opts.finalCases) {
    if (exceedsCost(spent + 2 * opts.finalCases.length * costLimit, budgetCost)) {
      stopReason = [stopReason, "Final audit skipped: budget exhausted"].filter(Boolean).join("; ");
    } else {
      const auditCases: ReflectiveCase[] = opts.finalCases.map((c) => ({ ...c, split: "validation" as const }));
      const ids = auditCases.map((c) => c.id);
      const audit = await labelled("Final audit", () => evaluate(`${opts.id}/final-test`, {
        initial: initialVersion, stage: "audit", candidatePrompts: sets.get(champion)!, cases: auditCases,
        runs: { baseline: ids, candidate: ids }, known: { baseline: [], candidate: [] } }));
      const { baseline, candidate, executed } = audit.evaluation;
      let test: { accepted: boolean; reason: string } | null = null;
      if (finalTest) {
        const before = new Map(executed.baseline.map((o) => [o.caseId, o.score]));
        const differences = executed.candidate.map((o) => o.score - before.get(o.caseId)!);
        if (differences.some((d) => Math.abs(d) > finalTest.scoreRange)) throw new Error("Final scores exceed finalTest.scoreRange");
        const decision = sequentialDecision(differences, { minimumGain: finalTest.minimumGain, range: 2 * finalTest.scoreRange,
          alpha: finalTest.alpha, comparisons: 1 });
        const safe = candidate.validation!.violations <= baseline.validation!.violations;
        test = { accepted: decision.accepted && safe, reason: `${decision.reason}${safe ? "" : "; violations increased"}` };
      }
      finalAudit = { baselineMean: baseline.validation!.mean, championMean: candidate.validation!.mean,
        baselineViolations: baseline.validation!.violations, championViolations: candidate.validation!.violations,
        cases: opts.finalCases.length, test };
    }
  }

  return { id: opts.id, champion: unwrap(sets.get(champion)!), initial: opts.initialPrompt, roundsCompleted: history.length,
    stopReason, history, frontier: frontier().map((e) => ({ ...e, prompt: unwrap(sets.get(e.prompt)!) })),
    executions, spent, reflectionCalls, merges, finalAudit };
}
