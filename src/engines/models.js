// Model policy: keep a story on one model when possible, otherwise spread the work
// across the free provider pool (see pool.js). Nothing here needs a paid account.
import { PROVIDERS } from "./providers.js";
import { translatePinned, translatePooled, PoolExhaustedError, configuredProviders, poolStatus } from "./pool.js";
import { isTransient, isModelMissing, retryAfterMs, sleep } from "./limits.js";

export const PRIMARY = { provider: "groq", model: "openai/gpt-oss-120b" };
export const BACKUP = { provider: "gemini", model: "gemini-flash-latest" };

export { isTransient, isModelMissing, retryAfterMs, configuredProviders, poolStatus, PoolExhaustedError };

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
    provider === "gemini" ? /(flash|pro)/i : provider === "openrouter" ? /:free$/i : /(gpt-oss|llama|qwen|gemma|mistral|deepseek)/i;
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
 * Translate one chunk.
 *  1. the story's pinned model (keeps a book's voice consistent), with one
 *     model-swap attempt if that exact model was retired;
 *  2. otherwise the free provider pool, which spreads load across every free tier.
 */
export async function translateWithPolicy(chunk, opts = {}) {
  const { pinned = null, timeoutMs = 120000, fetchFn = fetch, ...rest } = opts;
  const attempts = [];

  if (pinned?.provider && envKey(pinned.provider)) {
    // Use the pinned model directly on the hot path. Only query the provider's
    // model catalog after an explicit model-missing response.
    const models = [pinned.model || PROVIDERS[pinned.provider]?.models?.[0]].filter(Boolean);
    for (const model of models) {
      try {
        const r = await translatePinned(chunk, { ...rest, fetchFn, timeoutMs }, { provider: pinned.provider, model });
        return { ...r, attempts: [...attempts, ...r.attempts] };
      } catch (e) {
        attempts.push({ provider: `${pinned.provider}/${model}`, ok: false, error: String(e.message).slice(0, 160) });
        if (!isModelMissing(e.message)) break; // rate limits go through the pool
        const candidates = pickCandidates(pinned.provider, await listModels(pinned.provider, envKey(pinned.provider), fetchFn).catch(() => []));
        const replacement = candidates.find((candidate) => !models.includes(candidate));
        if (replacement) models.push(replacement);
        await sleep(150);
      }
    }
  }

  try {
    const r = await translatePooled(chunk, { ...rest, fetchFn, timeoutMs });
    return { ...r, attempts: [...attempts, ...r.attempts] };
  } catch (e) {
    const detail = (e.attempts || attempts).map((a) => `${a.provider}: ${a.error || "ok"}`).join(" | ");
    throw new Error(
      "No free model could translate this right now. Add a fresh key (Groq free tier: console.groq.com) or retry in a few minutes — " +
      "nothing was overwritten, and it resumes from here. Details: " + detail
    );
  }
}
