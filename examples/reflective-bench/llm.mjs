// Minimal OpenAI-compatible chat client (OpenAI, OpenRouter, vLLM, Ollama, LM Studio,
// Anthropic's OpenAI-compatible endpoint, ...). No dependency. Cost unit: tokens.

export function chatClient({ baseUrl, apiKey, model, temperature = 0, maxTokens = 512, timeoutMs = 120_000 }) {
  if (!baseUrl || !model) throw new Error("Set MUTARA_LLM_BASE_URL and MUTARA_LLM_MODEL");
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return async (messages) => {
    const started = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("LLM response has no message content");
    const usage = body.usage ?? {};
    const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    if (!tokens) throw new Error("LLM response has no token usage; cost accounting needs it");
    return { text, tokens, ms: performance.now() - started };
  };
}
