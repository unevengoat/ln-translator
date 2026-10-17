// Model policy: Groq primary, Gemini extreme backup (per user config).
// A story's translations are pinned to the model that made them; we only
// switch models when the pinned one is gone (404/410/retired), by probing the
// provider's live model list — otherwise we fail loudly and ask for a new key
// instead of silently changing the story's voice.
import { translateAiChunk } from "./aiEngine.js";
import { resolveProvider, PROVIDERS } from "./providers.js";

export const PRIMARY = { provider: "groq", model: "openai/gpt-oss-120b" };
export const BACKUP = { provider: "gemini", model: "gemini-flash-latest" };

export function isModelGone(status, body) {
  if (status === 404 || status === 410) return true;
  return /model[^.]{0,80}(not found|does not exist|gone|decommission|retire|s unavailable)|no longer available/i.test(body || "");
}

async function listModels(provider, apiKey, fetchFn = fetch) {
  if (provider === "gemini") {
    const r = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!r.ok) throw new Error(`gemini models HTTP ${r.status}`);
    const { models } = await r.json();
    return models.map((m) => String(m.name).replace(/^models\//, ""));
  }
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const r = await fetchFn(`${(preset.baseUrl || "").replace(/\/+$/, "")}/models`, {
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(preset.headers || {}) },
  });
  if (!r.ok) throw new Error(`${provider} models HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const data = await r.json();
  return (data.data || []).map((m) => m.id);
}

/** Pick up to 2 chat-capable replacement candidates, best first. */
export function pickCandidates(provider, ids) {
  const chat = ids.filter((id) => !/embed|whisper|tts|image|guard|moderation|realtime|vision|transcri|okash/i.test(id));
  const preferred =
    provider === "gemini"
      ? /(flash|pro)/i
      : provider === "openrouter"
        ? /:free$/i
        : /(gpt-oss|llama|qwen|gemma|mistral|deepseek)/i;
  return [...chat.filter((id) => preferred.test(id)), ...chat.filter((id) => !preferred.test(id))]
    .filter((id, i, a) => a.indexOf(id) === i)
    .slice(0, 2);
}

function envKey(provider) {
  const preset = PROVIDERS[provider];
  if (!preset) return "";
  return process.env[preset.keyEnv] || process.env.AI_API_KEY || "";
}

/**
 * Translate one chunk under the groq→gemini policy.
 * pinned: {provider, model} to try first (keeps one story on one model).
 * strict: never fall back to keyless MT — throw and ask for a new key instead.
 */
export async function translateWithPolicy(chunk, opts = {}) {
  const {
    source = "auto", target = "en", keepHonorifics = true, formality = "match",
    glossary = [], prevTail = "", pinned = null, strict = true,
    fetchFn = fetch, timeoutMs = 120000,
  } = opts;
  const legs = [];
  if (pinned?.provider) legs.push({ ...PRIMARY, ...pinned });
  legs.push(PRIMARY, BACKUP);
  const seen = new Set();
  const attempts = [];
  const errors = [];

  for (const leg of legs) {
    const key = `${leg.provider}/${leg.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const apiKey = envKey(leg.provider) || opts.apiKey;
    if (!apiKey && PROVIDERS[leg.provider]?.needsKey) {
      attempts.push({ provider: key, ok: false, error: "no key configured" });
      errors.push(`${key}: no key`);
      continue;
    }
    const triedModels = new Set();
    const candidates = [leg.model];
    let candidateList = null;
    while (candidates.length) {
      const model = candidates.shift();
      if (triedModels.has(model)) continue;
      triedModels.add(model);
      try {
        const config = resolveProvider(leg.provider, { model, apiKey, timeoutMs });
        const text = await translateAiChunk(chunk, {
          source, target, keepHonorifics, formality, glossary, prevTail, config, fetchFn,
        });
        attempts.push({ provider: `${leg.provider}/${model}`, ok: true });
        return { text, provider: leg.provider, model, attempts };
      } catch (e) {
        const m = e.message;
        attempts.push({ provider: `${leg.provider}/${model}`, ok: false, error: m.slice(0, 160) });
        errors.push(`${leg.provider}/${model}: ${m.slice(0, 120)}`);
        // Model retired? Probe the provider's live list once, try replacements.
        if (!candidateList && /HTTP (404|410)/.test(m) && isModelGone(404, m)) {
          try {
            candidateList = pickCandidates(leg.provider, await listModels(leg.provider, apiKey, fetchFn));
            for (const c of candidateList) if (!triedModels.has(c)) candidates.push(c);
          } catch (le) {
            errors.push(`${leg.provider} model-list: ${le.message.slice(0, 100)}`);
          }
        }
      }
    }
  }

  if (!strict) {
    const { translateFree } = await import("./freeEngine.js");
    const { protectTerms } = await import("./glossary.js");
    const { text: guarded, restore } = protectTerms(chunk, glossary);
    const text = restore(await translateFree(guarded, { source, target, fetchFn }));
    attempts.push({ provider: "free-mt", ok: true });
    return { text, provider: "free-mt", model: "mt", attempts };
  }
  throw new Error(
    "Both story models are unavailable (Groq primary, Gemini backup). " +
    "Add a fresh key (Groq free tier: console.groq.com) and retry — nothing was overwritten. " +
    "Details: " + errors.join(" | ")
  );
}
