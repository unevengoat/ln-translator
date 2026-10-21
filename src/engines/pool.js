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
const providerQueues = new Map();
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
    // Ollama only exists if you explicitly point at it (it is not on the server).
    .filter((p) => p !== "ollama" || !!process.env.OLLAMA_URL)
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

function readyNow(s, now = Date.now()) {
  if (s.disabled) return false;
  if (s.cooldownUntil > now) return false;
  if (s.inFlight >= s.maxConcurrent) return false;
  if (now - s.lastAt < s.minGapMs) return false;
  return true;
}

function waitForNextProvider() {
  const now = Date.now();
  const nextReadyIn = [...state.values()].filter((s) => !s.disabled).map((s) =>
    Math.max(s.cooldownUntil - now, s.lastAt + s.minGapMs - now, 0)
  );
  if (!nextReadyIn.length) return sleep(250);
  const soonest = Math.min(...nextReadyIn);
  return sleep(Math.min(Math.max(soonest, 50), 4000));
}

function finishProviderRequest(s) {
  s.inFlight = Math.max(0, s.inFlight - 1);
}

async function reserveProviderSlot(s, deadline) {
  while (Date.now() < deadline) {
    const now = Date.now();
    if (readyNow(s, now)) {
      // Reserve synchronously after the readiness check so parallel waiters
      // cannot all pass the same provider's concurrency limit.
      s.lastAt = now;
      s.inFlight++;
      return true;
    }
    const waitMs = Math.max(s.cooldownUntil - now, s.lastAt + s.minGapMs - now, 100);
    await sleep(Math.min(waitMs, 4000));
  }
  return false;
}

/** Keep provider requests serialized, paced, and ordered during cooldown waits. */
function withProviderQueue(provider, task) {
  const previous = providerQueues.get(provider) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tail = current.then(() => {}, () => {});
  providerQueues.set(provider, tail);
  return current.finally(() => {
    if (providerQueues.get(provider) === tail) providerQueues.delete(provider);
  });
}

function coolDown(s, message) {
  if (!isTransient(message)) return;
  const wait = Math.max(retryAfterMs(message), s.cooldownMs);
  s.cooldownUntil = Date.now() + wait;
  s.rateLimited++;
  if (/quota|exceeded your current/i.test(message)) s.cooldownUntil = Date.now() + Math.max(wait, 300000);
}

/** Translate a pinned model while honoring the same provider pacing as the pool. */
export async function translatePinned(chunk, opts = {}, pinned, { maxWaitMs } = {}) {
  const s = st(pinned.provider);
  return withProviderQueue(pinned.provider, async () => {
    const deadline = Date.now() + (maxWaitMs ?? envNum("POOL_DEADLINE_MS", 300000));
    if (!await reserveProviderSlot(s, deadline)) {
      throw new PoolExhaustedError(`Timed out waiting for ${pinned.provider} pacing/cooldown.`);
    }
    try {
      const config = resolveProvider(pinned.provider, { model: pinned.model, timeoutMs: opts.timeoutMs });
      const text = await translateAiChunk(chunk, { ...opts, config });
      finishProviderRequest(s);
      s.ok++;
      s.modelIndex = 0;
      return { text, provider: pinned.provider, model: config.model, attempts: [{ provider: `${pinned.provider}/${config.model}`, ok: true }] };
    } catch (e) {
      finishProviderRequest(s);
      s.failed++;
      s.lastError = String(e.message).slice(0, 200);
      coolDown(s, e.message);
      throw e;
    }
  });
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
  const budget = maxWaitMs ?? envNum("POOL_DEADLINE_MS", 300000);
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    const pool = allow ? allow : configuredProviders().map((c) => c.provider);
    if (!pool.length) break;
    const s = pick(excluded, allow);
    if (!s) {
      // Nothing is ready: wait for a provider's pacing gap or cooldown to end.
      await waitForNextProvider();
      if (excluded.size && excluded.size >= pool.length) excluded.clear(); // give everything another chance
      continue;
    }
    const provider = s.provider;
    const model = modelFor(s);
    try {
      const result = await withProviderQueue(provider, async () => {
        if (!await reserveProviderSlot(s, deadline)) return null;
        try {
          const config = resolveProvider(provider, { model });
          const text = await translateAiChunk(chunk, { ...opts, config });
          finishProviderRequest(s);
          s.ok++;
          s.modelIndex = 0;
          return { text, provider, model: config.model, attempts: [{ provider: `${provider}/${config.model}`, ok: true }] };
        } catch (e) {
          finishProviderRequest(s);
          s.failed++;
          s.lastError = String(e.message).slice(0, 200);
          coolDown(s, e.message);
          throw e;
        }
      });
      if (result) {
        attempts.push(...result.attempts);
        return { ...result, attempts };
      }
      excluded.add(provider);
      if (excluded.size >= pool.length) {
        excluded.clear();
        await waitForNextProvider();
      }
    } catch (e) {
      attempts.push({ provider: `${provider}/${model}`, ok: false, error: String(e.message).slice(0, 160) });
      if (!isTransient(e.message)) {
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
