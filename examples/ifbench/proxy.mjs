// Local OpenAI-compatible accounting proxy, shared by both optimizers so that calls and
// tokens are counted the same way outside either system. `/<tag>/v1/chat/completions` is
// forwarded upstream and appended to ledger(tag) as one JSON line per completed call:
// { at, model, status, promptTokens, completionTokens, ms }. The Authorization header is
// passed through and never recorded. With `stub: true` it answers itself (dry runs and the
// crash test): plain text, dspy ChatAdapter fields, or a fenced instruction for GEPA's reflector.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

function stubReply(messages) {
  const text = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const request = text.split("Respond with the corresponding output fields").at(-1);
  const fields = [...request.matchAll(/\[\[ ## (\w+) ## \]\]/g)].map((m) => m[1]).filter((f) => f !== "completed");
  if (fields.length && request !== text) {
    return [...new Set(fields)].map((f) => `[[ ## ${f} ## ]]\nStub ${f}: a short answer.`).join("\n\n") + "\n\n[[ ## completed ## ]]";
  }
  if (text.includes("```")) return "```\nFollow every constraint stated in the query exactly.\n```";
  return "Stub answer: a short response to the query.";
}

export function startProxy({ upstream, stub = false, ledger, stubMs = 20 }) {
  if (!stub && !upstream) throw new Error("Set MUTARA_LLM_BASE_URL");
  const server = createServer(async (req, res) => {
    const match = req.url.match(/^\/([^/]+)\/v1(\/.*)$/);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const started = performance.now();
    let status = 500, body = "", usage = {}, model = null;
    try {
      if (!match || req.method !== "POST") { status = 404; body = "{}"; }
      else {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        model = request.model;
        if (stub) {
          await new Promise((r) => setTimeout(r, stubMs));
          const content = stubReply(request.messages ?? []);
          usage = { prompt_tokens: Math.ceil(JSON.stringify(request.messages).length / 4), completion_tokens: Math.ceil(content.length / 4) };
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          status = 200;
          body = JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
        } else {
          const response = await fetch(`${upstream.replace(/\/$/, "")}${match[2]}`, { method: "POST", body: Buffer.concat(chunks),
            headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) } });
          status = response.status;
          body = await response.text();
          if (response.ok) usage = JSON.parse(body).usage ?? {};
        }
      }
    } catch (error) {
      body = JSON.stringify({ error: { message: `proxy: ${error.message}` } });
    }
    if (match) appendFileSync(ledger(decodeURIComponent(match[1])), JSON.stringify({ at: Date.now(), model, status,
      promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0, ms: Math.round(performance.now() - started) }) + "\n");
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: (tag) => `http://127.0.0.1:${server.address().port}/${encodeURIComponent(tag)}/v1`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

/** Paid calls and tokens in a ledger: completed 2xx calls only. */
export function readLedger(text) {
  const calls = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.status >= 200 && c.status < 300);
  return { calls: calls.length, tokens: calls.reduce((n, c) => n + c.promptTokens + c.completionTokens, 0) };
}
