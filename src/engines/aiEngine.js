// AI engine: any OpenAI-compatible Chat Completions API.
// (Groq, Cerebras, Gemini, OpenRouter, Mistral, NVIDIA, Pollinations,
//  OpenAI, Ollama, LM Studio...)
import { buildSystemPrompt, buildUserMessage, languageName } from "../prompt.js";
import { resolveProvider } from "./providers.js";

export function resolveAiConfig(opts = {}) {
  const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== ""));
  const cfg = resolveProvider(clean.provider || "custom", clean);
  return { temperature: 0.3, ...cfg, ...clean, headers: cfg.headers };
}

export async function translateAiChunk(chunk, { source = "auto", target = "en", keepHonorifics = true, formality = "match", glossary = [], prevTail = "", notes = "", config, fetchFn = fetch }) {
  const cfg = config || resolveAiConfig({});
  const system = buildSystemPrompt({
    sourceName: languageName(source),
    targetName: languageName(target),
    keepHonorifics,
    formality,
    glossary,
    notes,
  });
  const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      ...(cfg.headers || {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: buildUserMessage(chunk, prevTail) },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI API [${cfg.provider}/${cfg.model}] HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Some providers (reasoning models, Pollinations) put the answer in
  // reasoning_content / reasoning instead of content.
  const msg = data?.choices?.[0]?.message || {};
  const text = (msg.content || msg.reasoning_content || msg.reasoning || "").trim();
  if (!text) throw new Error(`AI API [${cfg.provider}/${cfg.model}] returned no content`);
  return text;
}
