// Provider presets for the AI engine. No secrets here — keys come from
// env vars, CLI flags, or the web UI (never committed).
export const PROVIDERS = {
  groq: {
    label: "Groq (generous free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    needsKey: true,
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  },
  // Same account/key but a different model — Groq rate-limits per model, so this
  // effectively doubles free throughput. (qwen3.8-27b benchmarked at ~0.5s/chunk.)
  "groq-fast": {
    label: "Groq fast (Qwen 27B — separate limits)",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    needsKey: true,
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  },
  cerebras: {
    label: "Cerebras (fast free tier)",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    needsKey: true,
    models: ["qwen-3.8-27b", "gpt-oss-120b"],
  },
  gemini: {
    label: "Gemini (free AI Studio tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
    needsKey: true,
    models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  openrouter: {
    label: "OpenRouter (:free models)",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    needsKey: true,
    headers: { "HTTP-Referer": "https://localhost", "X-Title": "LN Translator" },
    models: ["google/gemma-4-31b-it:free", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "google/gemma-4-26b-a4b-it:free"],
  },
  mistral: {
    label: "Mistral (trial credits)",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    needsKey: true,
    models: ["mistral-small-latest", "mistral-medium-latest"],
  },
  nvidia: {
    label: "NVIDIA NIM (free tier)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    needsKey: true,
    models: ["deepseek-ai/deepseek-v4.1-flash", "google/gemma-3-12b-it", "meta/llama-3.2-90b-vision-instruct"],
  },
  pollinations: {
    label: "Pollinations (no key needed)",
    baseUrl: "https://text.pollinations.ai/openai",
    keyEnv: "POLLINATIONS_API_KEY",
    needsKey: false,
    models: ["openai"],
  },
  custom: {
    label: "Custom OpenAI-compatible (Ollama / LM Studio / OpenAI)",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "AI_API_KEY",
    needsKey: true,
    models: [],
  },
};

/** Resolve { baseUrl, apiKey, model, headers } for a provider + user overrides. */
export function resolveProvider(name, overrides = {}) {
  const preset = PROVIDERS[name] || PROVIDERS.custom;
  const baseUrl = (overrides.baseUrl || process.env.AI_BASE_URL || preset.baseUrl || "").replace(/\/+$/, "");
  const apiKey = overrides.apiKey || process.env[preset.keyEnv] || process.env.AI_API_KEY || "";
  const model = overrides.model || process.env.AI_MODEL || preset.models[0] || "gpt-4o-mini";
  const headers = { ...(preset.headers || {}), ...(overrides.headers || {}) };
  if (preset.needsKey && !apiKey) {
    throw new Error(`${preset.label} needs an API key (set ${preset.keyEnv}, pass --key, or enter it in the web UI).`);
  }
  if (!baseUrl) throw new Error(`No base URL for provider "${name}" (pass --base-url).`);
  return { provider: name in PROVIDERS ? name : "custom", baseUrl, apiKey, model, headers };
}

/** Quality chain: Groq primary, Gemini extreme backup — nothing else. */
export const DEFAULT_CHAIN = ["groq", "gemini"];

/** Expand the magic provider "auto" into DEFAULT_CHAIN entries. */
export function expandAuto(specs) {
  return (specs || []).flatMap((s) => {
    const item = typeof s === "string" ? { provider: s } : s;
    if (item.provider !== "auto") return [item];
    return DEFAULT_CHAIN.map((provider) => ({ provider }));
  });
}

/** Parse "groq,cerebras:llama-3.3-70b,pollinations" into [{provider, model?}]. */
export function parseChain(spec) {
  if (!spec) return [];
  return String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [provider, ...rest] = item.split(":");
      return { provider: provider.trim() || "custom", model: rest.join(":").trim() || undefined };
    });
}

/** Public (secret-free) provider list for the web UI dropdown. */
export function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    needsKey: p.needsKey,
    keyEnv: p.keyEnv,
    models: p.models,
  }));
}
