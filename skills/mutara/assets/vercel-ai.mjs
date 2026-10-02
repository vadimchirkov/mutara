// Copy into the host project and replace the task-specific parts (case text,
// expected shape, scoring). No dependency on `ai`: pass your `generateText`
// (or a stub in tests) with the same duck-typed shape.
//
// Vercel AI SDK shape used here:
//   generateText({ model, system, prompt, temperature, maxOutputTokens, stopWhen, tools })  (AI SDK 5+)
//   -> { text, toolCalls?, steps?, usage?: { inputTokens, outputTokens, totalTokens } }
// AI SDK 4 names (maxTokens, maxSteps, promptTokens, completionTokens) also work.
// Cost unit is tokens by default, or USD when `pricePerM` (blended $ per 1M tokens) is set.
//
// Mutara contracts (see skills/mutara/references/api.md):
// - reflective `run(prompt, c)` -> { output, cost, trace? }; `score(receipt, c)` -> { score, violation?, feedback? }
// - gate `baseline/candidate(c)` -> { output, cost }
// - optimizer `execute(config, ctx)` -> { output: Record<string, number>, cost }
// Expected labels never reach the runner: cases pass only `input` here.

/** Input/output token counts under AI SDK 5 (`inputTokens`) or 4 (`promptTokens`) names. */
const inputTokens = (usage) => usage?.inputTokens ?? usage?.promptTokens;
const outputTokens = (usage) => usage?.outputTokens ?? usage?.completionTokens;
const hasUsage = (usage) => usage != null && [usage.totalTokens, inputTokens(usage), outputTokens(usage)].some((n) => n != null);

/** Tokens (or USD when priced) for one `generateText` result. */
export function usageCost(usage, pricePerM = 0) {
  if (!hasUsage(usage)) throw new Error("LLM response has no token usage; cost accounting needs it");
  const prompt = Number(inputTokens(usage) ?? 0);
  const completion = Number(outputTokens(usage) ?? 0);
  const total = Number(usage.totalTokens ?? (prompt + completion));
  if (!Number.isFinite(total) || total < 0) throw new Error("LLM response has no token usage; cost accounting needs it");
  return pricePerM ? (total * pricePerM) / 1e6 : total;
}

/**
 * USD cost from split input/output prices.
 * `prices` maps model ID to `{ input, output }` ($ per 1M tokens) or `{ blended }`.
 * Split entries need input + output token counts; without them use `blended`.
 */
export function usdCost(usage, prices, modelId) {
  const entry = prices?.[modelId];
  if (!entry) throw new Error(`No price entry for model ${JSON.stringify(modelId)}`);
  if (entry.blended != null) return usageCost(usage, entry.blended);
  const prompt = Number(inputTokens(usage)), completion = Number(outputTokens(usage));
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
    throw new Error("Split pricing needs input and output token counts in usage");
  }
  return (prompt * entry.input + completion * entry.output) / 1e6;
}

/**
 * Raw tool calls from every step. `result.toolCalls` holds only the last step, which
 * is empty once a tool with `execute` ran and the model answered, so `steps` wins.
 */
function rawCalls(result) {
  if (Array.isArray(result?.steps) && result.steps.length) return result.steps.flatMap((s) => s?.toolCalls ?? []);
  if (result?.toolCalls !== undefined && !Array.isArray(result.toolCalls)) throw new Error("toolCalls must be an array");
  return result?.toolCalls;
}

/** Keep traces small: full steps stay in the provider, not in the journal. */
function traceOf(result, maxChars = 2000) {
  const calls = rawCalls(result) ?? null;
  const trace = JSON.stringify({ finish: result?.finishReason ?? null, calls });
  return trace.length > maxChars ? `${trace.slice(0, maxChars)}…` : trace;
}

/**
 * Build a Mutara-compatible text runner around `generateText`.
 *
 * @param {object} args
 * @param {(params: object) => Promise<object>} args.generateText - `import { generateText } from "ai"` or a stub.
 * @param {unknown} args.model - model handle, e.g. `openai("gpt-4.1-mini")`. Kept out of the journal; pin its ID in `implementation`.
 * @param {object} [args.params] - pinned generation settings, e.g. `{ temperature: 0, maxTokens: 512 }`. Use temperature 0 for eval.
 * @param {number} [args.pricePerM] - blended USD per 1M tokens; omit for token costs.
 */
export function createTextRunner({ generateText, model, params = {}, pricePerM = 0 }) {
  if (typeof generateText !== "function") throw new Error("generateText is required");
  return async (system, c) => {
    const text = c?.input?.text ?? c?.input?.prompt;
    if (typeof system !== "string" || !system.trim()) throw new Error("system prompt must be a nonempty string");
    if (typeof text !== "string" || !text.trim()) throw new Error("case input.text must be a nonempty string");
    const result = await generateText({ model, system, prompt: text, ...params });
    if (typeof result?.text !== "string") throw new Error("generateText must resolve { text: string }");
    return { output: result.text, cost: usageCost(result?.usage, pricePerM), trace: traceOf(result) };
  };
}

/** Exact-match score with actionable feedback for the reflector. */
export function exactScore(output, expected) {
  const ok = output === expected;
  return { score: Number(ok), violation: 0, feedback: ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}` };
}

/** Fraction of expected fields exactly right; shared by JSON-text and object scoring. */
function fieldsScore(reply, expected) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    return { score: 0, violation: 1, feedback: "Reply was not a JSON object." };
  }
  const wrong = Object.keys(expected).filter((k) => String(reply[k]) !== String(expected[k]));
  return {
    score: (Object.keys(expected).length - wrong.length) / Math.max(Object.keys(expected).length, 1),
    violation: 0,
    feedback: wrong.length ? wrong.map((k) => `${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(reply[k] ?? null)}`).join("; ") : undefined,
  };
}

/** Fraction of JSON fields exactly right; non-JSON output is a violation (hard rule, not a tradeoff). */
export function jsonFieldsScore(output, expected) {
  const body = String(output).replace(/```(?:json)?/g, "");
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { score: 0, violation: 1, feedback: "Reply was not a JSON object." };
  let reply;
  try {
    reply = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { score: 0, violation: 1, feedback: "Reply was not valid JSON." };
  }
  return fieldsScore(reply, expected);
}

/** Same field-fraction score for an already-parsed object (e.g. `generateObject`). */
export function objectScore(output, expected) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { score: 0, violation: 1, feedback: "Reply was not an object." };
  }
  return fieldsScore(output, expected);
}

/** A schema validation failure is a failed answer (grade violation), not transport. */
function isNoObjectError(error) {
  return typeof error?.name === "string" && error.name.includes("NoObjectGenerated");
}

/**
 * Build a Mutara-compatible runner around `generateObject`.
 * The error carries the raw text and usage: a validation failure returns a
 * gradable `{ output: null }` receipt instead of blocking the experiment.
 * `schema` is passed through opaquely (Zod, JSON schema, ...); pin it in
 * `implementation` as JSON. `price` is a blended $/1M number or
 * `{ prices, model }` for `usdCost`.
 */
export function createObjectRunner({ generateObject, model, schema, params = {}, price = 0 }) {
  if (typeof generateObject !== "function") throw new Error("generateObject is required");
  const costOf = (usage) => typeof price === "number"
    ? usageCost(usage, price)
    : usdCost(usage, price.prices, price.model);
  return async (system, c) => {
    const text = c?.input?.text ?? c?.input?.prompt;
    if (typeof system !== "string" || !system.trim()) throw new Error("system prompt must be a nonempty string");
    if (typeof text !== "string" || !text.trim()) throw new Error("case input.text must be a nonempty string");
    const args = { model, system, prompt: text, ...(schema === undefined ? {} : { schema }), ...params };
    try {
      const result = await generateObject(args);
      if (!result || typeof result.object !== "object" || result.object === null || Array.isArray(result.object)) {
        throw new Error("generateObject must resolve { object }");
      }
      return { output: result.object, cost: costOf(result?.usage), trace: `keys:${Object.keys(result.object).join(",")}` };
    } catch (error) {
      if (isNoObjectError(error)) {
        return { output: null, cost: hasUsage(error?.usage) ? costOf(error.usage) : 0, trace: "NoObjectGeneratedError" };
      }
      throw error;
    }
  };
}

/**
 * Normalize tool calls from a `generateText` result (all `steps`, else
 * `toolCalls`) to `{ name, args }`. Tool-result error states differ across SDK
 * versions, so assert on results in host-specific scoring, not here.
 */
export function toolCallsOf(result) {
  const raw = rawCalls(result) ?? [];
  return raw.map((t) => {
    const name = t?.toolName ?? t?.name;
    if (typeof name !== "string" || !name) throw new Error("tool call must have a name");
    return { name, args: t?.args ?? t?.input ?? {} };
  });
}

function argsSubset(actual, expected) {
  if (expected === undefined) return true;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => JSON.stringify(actual[k]) === JSON.stringify(v));
}

/** 1 iff the tool was called at least `times` (with matching `args` subset when given). */
export function calledTool(calls, name, { times = 1, args } = {}) {
  const matching = calls.filter((c) => c.name === name && argsSubset(c.args, args));
  const ok = matching.length >= times;
  return {
    score: Number(ok),
    violation: 0,
    feedback: ok ? undefined : `expected ${name} ×${times}${args === undefined ? "" : ` with ${JSON.stringify(args)}`}, got ×${matching.length}`,
  };
}

/** 1 iff the named tools appear in order (as a subsequence of the calls). */
export function toolSequence(calls, names) {
  if (!Array.isArray(names) || !names.length) throw new Error("names must be a nonempty array");
  let i = 0;
  for (const c of calls) if (c.name === names[i]) i++;
  const ok = i === names.length;
  return {
    score: Number(ok),
    violation: 0,
    feedback: ok ? undefined : `expected tool order ${names.join(" -> ")}, got ${calls.map((c) => c.name).join(", ") || "(none)"}`,
  };
}
