// Minimal OpenAI-compatible chat client (OpenAI, OpenRouter, vLLM, Ollama, LM Studio,
// Anthropic's OpenAI-compatible endpoint, ...). No dependency. Cost unit: tokens.

export function chatClient({ baseUrl, apiKey, model, temperature = 0, maxTokens = 512, timeoutMs = 120_000 }) {
  if (!baseUrl || !model) throw new Error("Set MUTARA_LLM_BASE_URL and MUTARA_LLM_MODEL");
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return async (messages) => {
    const started = performance.now();
    let response, body;
    const transient = (status) => status === 429 || status >= 500;
    // Rate limits and transient server errors cost nothing: back off and retry here. Routers
    // such as OpenRouter may also return 200 with the provider's error in the body.
    for (let attempt = 0; ; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        body = await response.json();
        if (!transient(Number(body?.error?.code)) || attempt >= 6) break;
      } else if (!transient(response.status) || attempt >= 6) break;
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const choice = body?.choices?.[0];
    // A reasoning model that hits max_tokens before answering returns no content: that is a
    // failed answer (empty text), not a transport error.
    const text = choice?.message?.content ?? (choice?.finish_reason === "length" ? "" : undefined);
    if (typeof text !== "string") throw new Error(`LLM response has no message content: ${JSON.stringify(body).slice(0, 300)}`);
    const reasoning = typeof choice.message?.reasoning === "string" ? choice.message.reasoning : undefined;
    const usage = body.usage ?? {};
    const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    if (!tokens) throw new Error("LLM response has no token usage; cost accounting needs it");
    return { text, reasoning, tokens, ms: performance.now() - started };
  };
}
