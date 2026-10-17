// Orchestrator: chunk -> translate sequentially (continuity) -> rejoin.
// Engine "ai" accepts a single provider config or a fallback chain
// (e.g. groq -> cerebras -> pollinations): each chunk tries providers in order.
import { chunkNovel, joinChunks, normalizeText } from "../chunker.js";
import { protectTerms } from "../glossary.js";
import { translateFree } from "./freeEngine.js";
import { translateAiChunk, resolveAiConfig } from "./aiEngine.js";
import { parseChain, expandAuto, resolveProvider } from "./providers.js";

function resolveChain({ ai = {}, chain }) {
  let specs = chain ?? ai.chain ?? ai.chainSpec;
  if (typeof specs === "string") specs = parseChain(specs);
  if (!specs?.length && ai.provider === "auto") specs = [{ provider: "auto" }];
  specs = expandAuto(specs);
  if (specs.length) {
    return specs.map((s) => {
      if (typeof s === "string") return { kind: "ai", spec: { provider: s } };
      if (s.provider === "free") return { kind: "free" };
      if (s.provider === "custom" || !s.provider) return { kind: "ai", spec: { ...ai, provider: "custom" } };
      return {
        kind: "ai",
        spec: {
          provider: s.provider,
          model: s.model || (ai.provider === s.provider ? ai.model : undefined),
          apiKey: s.apiKey || ai.apiKey, // explicit/shared key, else per-provider env var
          baseUrl: s.baseUrl,
        },
      };
    });
  }
  return [{ kind: "ai", spec: ai }]; // single-provider path
}

export async function translateText(
  text,
  {
    source = "auto",
    target = "en",
    engine = "free",
    maxChunk = 1800,
    keepHonorifics = true,
    formality = "match",
    glossary = [],
    ai = {},
    chain,
    fetchFn = fetch,
    onProgress,
  } = {}
) {
  const norm = normalizeText(text);
  if (!norm) return { translation: "", chunks: 0, engine };
  if (source === target) throw new Error("Source and target languages are the same.");
  const chunks = chunkNovel(norm, maxChunk);
  const out = [];
  const aiChain = engine === "ai" ? resolveChain({ ai, chain }) : [];
  let usedProvider = null;
  const attempts = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let translated;
    if (engine === "ai") {
      const prevTail = out.length ? out[out.length - 1].slice(-500) : "";
      const errors = [];
      for (const leg of aiChain) {
        const legName = leg.kind === "free" ? "free-mt" : `${leg.spec.provider || "custom"}${leg.spec.model ? "/" + leg.spec.model : ""}`;
        try {
          if (leg.kind === "free") {
            const { text: guarded, restore } = protectTerms(chunk, glossary);
            translated = restore(await translateFree(guarded, { source, target, fetchFn }));
            usedProvider = "free-mt";
          } else {
            // Resolved lazily so legs with no key are skipped, not fatal.
            const config = resolveAiConfig(leg.spec);
            translated = await translateAiChunk(chunk, {
              source, target, keepHonorifics, formality, glossary, prevTail, config, fetchFn,
            });
            usedProvider = `${config.provider}/${config.model}`;
          }
          if (i === 0) attempts.push({ provider: legName, ok: true });
          break;
        } catch (e) {
          if (i === 0) attempts.push({ provider: legName, ok: false, error: e.message.slice(0, 160) });
          errors.push(e.message);
        }
      }
      if (translated === undefined) throw new Error("All providers failed: " + errors.join(" | "));
    } else {
      // Free MT follows no instructions, so enforce glossary via placeholder protection.
      const { text: guarded, restore } = protectTerms(chunk, glossary);
      translated = restore(await translateFree(guarded, { source, target, fetchFn }));
    }
    out.push(translated.trim());
    onProgress?.({ done: i + 1, total: chunks.length });
  }
  return { translation: joinChunks(out), chunks: chunks.length, engine, provider: usedProvider, attempts };
}
