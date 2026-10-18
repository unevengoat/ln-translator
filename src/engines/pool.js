// Free provider pool: translate chunks across EVERY free provider we can reach,
// in parallel, with per-provider pacing and cooldowns. This is what makes the
// "completely free" path actually usable: one throttled free tier is no longer a
// single point of failure — the work spreads across Groq, Gemini, Pollinations
// (keyless), OpenRouter :free, Mistral, Cerebras and NVIDIA NIM.
import { PROVIDERS, resolveProvider } from "./providers.js";
import { translateAiChunk } from "./aiEngine.js";
import { sleep, isTransient, retryAfterMs } from "./limits.js";

// Per-provider pacing. Concurrency > 1 only where a provider tolerates it.
const LIMITS = {
  pollinations: { minGapMs: 700, maxConcurrent: 3, cooldownMs: 12000 },
  "groq-fast": { minGapMs: 900, maxConcurrent: 1, cooldownMs: 20000 },
  groq: { minGapMs: 1200, maxConcurrent: 1, cooldownMs: 25000 },
  gemini: { minGapMs: 1500, maxConcurrent: 1, cooldownMs: 25000 },
  openrouter: { minGapMs: 1500, maxConcurrent: 1, cooldownMs: 30000 },
  mistral: { minGapMs: 1500, maxConcurrent: 1, cooldownMs: 30000 },
  cerebras: { minGapMs: 1500, maxConcurrent: 1, cooldownMs: 30000 },
  nvidia: { minGapMs: 1500, maxConcurrent: 1, cooldownMs: 30000 },
  custom: { minGapMs: 1200, maxConcurrent: 1, cooldownMs: 20000 },
};

const state = new Map();
const envNum = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);

function st(provider) {
  if (!state.has(provider)) {
    const base = LIMITS[provider] || LIMITS.custom;
    state.set(provider, {
      provider, inFlight: 0, lastAt: 0, cooldownUntil: 0, ok: 0, failed: 0, rateLimited: 0,
      modelIndex: 0, lastError: null,
      minGapMs: envNum("POOL_MIN_GAP_MS", base.minGapMs),
      maxConcurrent: envNum("POOL_MAX_CONCURRENT", base.maxConcurrent),
      cooldownMs: envNum("POOL_COOLDOWN_MS", base.cooldownMs),
    });
  }
  return state.get(provider);
}

function apiKeyFor(provider) {
  const preset = PROVIDERS[provider];
  if (!preset) return "";
  return process.env[preset.keyEnv] || process.env.AI_API_KEY || "";
}

/** Providers we can actually use right now (key present, or keyless). */
export function configuredProviders() {
  return Object.keys(PROVIDERS)
    .filter((p) => p !== "custom")
    .filter((p) => !PROVIDERS[p].needsKey || !!apiKeyFor(p))
    .map((p) => ({ provider: p, model: PROVIDERS[p].models?.[0] || "", keyless: !PROVIDERS[p].needsKey }));
}

export function poolStatus() {
  return [...state.values()].map((s) => ({
    provider: s.provider, inFlight: s.inFlight, ok: s.ok, failed: s.failed, rateLimited: s.rateLimited,
    coolingDown: s.cooldownUntil > Date.now(), cooldownMs: Math.max(0, s.cooldownUntil - Date.now()),
    lastError: s.lastError,
  }));
}

function readyNow(s) {
  if (s.disabled) return false;
  if (s.cooldownUntil > Date.now()) return false;
  if (s.inFlight >= s.maxConcurrent) return false;
  if (Date.now() - s.lastAt < s.minGapMs && s.inFlight > 0) return false;
  return true;
}

/** Best provider to use next: idle capacity first, then longest-resting. */
function pick(exclude = new Set(), allow = null) {
  const candidates = configuredProviders().map((c) => c.provider)
    .filter((p) => !exclude.has(p))
    .filter((p) => !allow || allow.includes(p));
  const ready = candidates.map(st).filter((s) => readyNow(s) && s.inFlight === 0);
  if (ready.length) return ready.sort((a, b) => a.lastAt - b.lastAt)[0];
  const usable = candidates.map(st).filter((s) => readyNow(s));
  if (usable.length) return usable.sort((a, b) => a.inFlight - b.inFlight || a.lastAt - b.lastAt)[0];
  return null; // everything busy or cooling down — caller waits
}

/** Model to try for a provider, walking its model list on "model missing". */
function modelFor(s) {
  const models = PROVIDERS[s.provider]?.models || [];
  return models[Math.min(s.modelIndex, models.length - 1)] || undefined;
}

export class PoolExhaustedError extends Error {}

/**
 * Translate one chunk using the free pool.
 * Returns { text, provider, model, attempts }.
 */
export async function translatePooled(chunk, opts = {}, { maxWaitMs } = {}) {
  const attempts = [];
  const excluded = new Set();
  const allow = Array.isArray(opts.providers) && opts.providers.length ? opts.providers : null;
  const budget = maxWaitMs ?? envNum("POOL_DEADLINE_MS", 90000);
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    const s = pick(excluded, allow);
    if (!s) {
      // nothing ready: wait a moment for a slot / cooldown to end
      const soonest = Math.min(...[...state.values()].map((x) => Math.max(0, x.cooldownUntil - Date.now())), 2000);
      await sleep(Math.min(Math.max(soonest, 100), 4000));
      const pool = allow ? allow : configuredProviders().map((c) => c.provider);
      if (excluded.size && excluded.size >= pool.length) excluded.clear(); // give everything another chance
      continue;
    }
    const provider = s.provider;
    const model = modelFor(s);
    s.inFlight++;
    s.lastAt = Date.now();
    try {
      const config = resolveProvider(provider, { model });
      const text = await translateAiChunk(chunk, { ...opts, config });
      s.inFlight--;
      s.ok++;
      s.modelIndex = 0;
      attempts.push({ provider: `${provider}/${config.model}`, ok: true });
      return { text, provider, model: config.model, attempts };
    } catch (e) {
      s.inFlight--;
      s.failed++;
      s.lastError = String(e.message).slice(0, 200);
      attempts.push({ provider: `${provider}/${model}`, ok: false, error: s.lastError.slice(0, 160) });

      if (isTransient(e.message)) {
        const wait = Math.max(retryAfterMs(e.message), s.cooldownMs);
        s.cooldownUntil = Date.now() + wait;
        s.rateLimited++;
        if (/quota|exceeded your current/i.test(e.message)) s.cooldownUntil = Date.now() + Math.max(wait, 300000); // daily quota → long rest
      } else {
        // Model retired? Walk this provider's model list, and after two misses
        // stop using the provider for this session (it would just waste attempts).
        s.modelIndex++;
        if (s.modelIndex >= (PROVIDERS[provider]?.models?.length || 1)) {
          s.modelIndex = 0;
          s.modelMisses = (s.modelMisses || 0) + 1;
          if (s.modelMisses >= 2) { s.disabled = true; excluded.add(provider); }
        }
      }
      await sleep(120);
    }
  }
  throw new PoolExhaustedError("Free pool exhausted. " + attempts.map((a) => `${a.provider}: ${a.error || "ok"}`).join(" | "));}
