// TypeSafe Noul reranks legal, untried pairs. No recipe table enters this module.
import { setTimeout as sleep } from "node:timers/promises";
import { policies, type GameView, type Policy } from "./game/policies.js";
import { pairKey } from "./game/table.js";

export const JUDGE_MODEL = "jev-1.13.0";
export const SHORTLIST_SIZE = 12;
export const JUDGE_QUESTION = "In Little Alchemy 2, does combining the two elements in PAIR produce at least one element not already in `known`? Consider the game's recipes and the meaning of both ingredients, not merely whether they are related.";

export interface JudgeRequest {
  model: string;
  state: { known: string[]; pairs: [string, string][] };
  questions: Record<string, { type: "noul"; instructions: string }>;
}

export interface JudgeResponse {
  model: string;
  answers: Record<string, { type: "noul"; noul: number }>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface Judgment {
  response: JudgeResponse;
  elapsedMs: number;
  httpAttempts: number;
}

export type Judge = (request: JudgeRequest) => Promise<Judgment>;

export function shortlist(view: GameView, rand: () => number, count = SHORTLIST_SIZE, policy: Policy = policies.empowerment): [string, string][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error("shortlist must be 1..64");
  const v = { ...view, tried: new Set(view.tried) };
  const pairs: [string, string][] = [];
  // ponytail: reuse the policy's scan; a heap only matters for much larger shortlists.
  while (pairs.length < count) {
    const pair = policy(v, rand);
    if (!pair) break;
    pairs.push(pair);
    v.tried.add(pairKey(...pair));
  }
  return pairs;
}

export function judgeRequest(known: string[], pairs: [string, string][], model = JUDGE_MODEL): JudgeRequest {
  if (!pairs.length) throw new Error("Cannot judge an empty shortlist");
  return {
    model,
    state: { known: [...known], pairs: structuredClone(pairs) },
    questions: Object.fromEntries(pairs.map((_, i) => [
      `p${i}`, { type: "noul", instructions: JUDGE_QUESTION.replace("PAIR", `\`pairs[${i}]\``) },
    ])),
  };
}

export function validateResponse(request: JudgeRequest, value: unknown): JudgeResponse {
  const r = value as JudgeResponse | null;
  if (!r || typeof r.model !== "string" || !r.model || !r.answers || !r.usage ||
      !Number.isSafeInteger(r.usage.input_tokens) || r.usage.input_tokens < 0 ||
      !Number.isSafeInteger(r.usage.output_tokens) || r.usage.output_tokens < 0 ||
      Object.keys(r.answers).length !== request.state.pairs.length ||
      request.state.pairs.some((_, i) => {
        const a = r.answers[`p${i}`];
        return a?.type !== "noul" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1;
      })) throw new Error("Invalid TypeSafe response");
  return r;
}

export function selectedPair(request: JudgeRequest, response: JudgeResponse): [string, string] {
  validateResponse(request, response);
  let best = 0;
  for (let i = 1; i < request.state.pairs.length; i++) {
    if (response.answers[`p${i}`].noul > response.answers[`p${best}`].noul) best = i;
  }
  return request.state.pairs[best];
}

export function typeSafeJudge(apiKey: string, fetcher: typeof fetch = fetch): Judge {
  if (!apiKey.trim()) throw new Error("Set TYPESAFE_API_KEY or ALCHEMY_API_KEY in .env");
  return async (request) => {
    const started = performance.now();
    const body = JSON.stringify(request);
    for (let attempt = 1; ; attempt++) {
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Retry only explicit rate-limit/overload rejections, never ambiguous failures.
        if ([429, 529].includes(response.status) && attempt < 3) {
          const retry = response.headers.get("retry-after");
          const delay = retry === null ? 500 * 2 ** (attempt - 1) :
            /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          if (Number.isFinite(delay) && delay <= 30_000) {
            await sleep(Math.max(0, delay));
            continue;
          }
        }
        throw new Error(`TypeSafe HTTP ${response.status}`);
      }
      return {
        response: validateResponse(request, await response.json()),
        elapsedMs: Math.round(performance.now() - started),
        httpAttempts: attempt,
      };
    }
  };
}
