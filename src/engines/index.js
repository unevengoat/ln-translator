// Orchestrator: chunk -> translate sequentially (continuity) -> rejoin.
// One quality-first chain: Groq primary, Gemini extreme backup. There is no
// keyless MT path — if neither model is available we fail loudly and ask for a
// fresh key instead of shipping a worse translation.
import { chunkNovel, joinChunks, normalizeText } from "../chunker.js";
import { translateAiChunk, resolveAiConfig } from "./aiEngine.js";
import { parseChain, expandAuto } from "./providers.js";

function resolveChain({ ai = {}, chain }) {
  let specs = chain ?? ai.chain ?? ai.chainSpec;
  if (typeof specs === "string") specs = parseChain(specs);
  if (!specs?.length && ai.provider === "auto") specs = [{ provider: "auto" }];
  specs = expandAuto(specs);
  if (specs.length) {
    return specs.map((s) => {
      if (typeof s === "string") return { spec: { provider: s } };
      return {
        spec: {
          provider: s.provider || "custom",
          model: s.model || (ai.provider === s.provider ? ai.model : undefined),
          apiKey: s.apiKey || ai.apiKey,
          baseUrl: s.baseUrl,
        },
      };
    });
  }
  return [{ spec: ai }]; // single-provider path
}

export async function translateText(
  text,
  { source = "auto", target = "en", engine = "ai", maxChunk = 1800, keepHonorifics = true, formality = "match", glossary = [], notes = "", ai = {}, chain, fetchFn = fetch, onProgress } = {}
) {
  const norm = normalizeText(text);
  if (!norm) return { translation: "", chunks: 0, engine, provider: null };
  if (source === target) throw new Error("Source and target languages are the same.");
  const chunks = chunkNovel(norm, maxChunk);
  const legs = resolveChain({ ai, chain });
  const out = [];
  let usedProvider = null;
  const attempts = [];

  for (let i = 0; i < chunks.length; i++) {
    const prevTail = out.length ? out[out.length - 1].slice(-500) : "";
    const errors = [];
    let translated;
    for (const leg of legs) {
      const legName = `${leg.spec.provider || "custom"}${leg.spec.model ? "/" + leg.spec.model : ""}`;
      try {
        const config = resolveAiConfig(leg.spec);
        translated = await translateAiChunk(chunks[i], {
          source, target, keepHonorifics, formality, glossary, notes, prevTail, config, fetchFn,
        });
        usedProvider = `${config.provider}/${config.model}`;
        if (i === 0) attempts.push({ provider: legName, ok: true });
        break;
      } catch (e) {
        if (i === 0) attempts.push({ provider: legName, ok: false, error: e.message.slice(0, 160) });
        errors.push(e.message);
      }
    }
    if (translated === undefined) {
      throw new Error(
        "All models failed: " + errors.join(" | ") +
        ". Add a fresh key (Groq free tier: console.groq.com) and retry — nothing was saved."
      );
    }
    out.push(translated.trim());
    onProgress?.({ done: i + 1, total: chunks.length });
  }
  return { translation: joinChunks(out), chunks: chunks.length, engine: "ai", provider: usedProvider, attempts };
}
