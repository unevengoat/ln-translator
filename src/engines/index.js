// Orchestrator for ad-hoc text translation (the "Quick translate" box and the CLI).
// Uses the free provider pool, so it keeps working when any single free tier is
// rate-limited. Long, resumable work goes through library.translateChapter instead.
import { chunkNovel, joinChunks, normalizeText } from "../chunker.js";
import { translateWithPolicy } from "./models.js";
import { parseChain, expandAuto } from "./providers.js";

function pinnedFrom({ ai = {}, chain }) {
  let specs = chain ?? ai.chain ?? ai.chainSpec;
  if (typeof specs === "string") specs = parseChain(specs);
  if (Array.isArray(specs) && specs.length === 1) {
    const s = typeof specs[0] === "string" ? { provider: specs[0] } : specs[0];
    const provider = s.provider || ai.provider;
    if (provider && provider !== "auto") return { provider, model: s.model || ai.model };
  }
  if (!specs && ai.provider && ai.provider !== "auto") return { provider: ai.provider, model: ai.model };
  return null;
}

export async function translateText(
  text,
  { source = "auto", target = "en", engine = "ai", maxChunk = 1800, keepHonorifics = true, formality = "match", glossary = [], notes = "", difficulty = "medium", ai = {}, chain, providers: optsProviders, fetchFn = fetch, onProgress, concurrency } = {}
) {
  const norm = normalizeText(text);
  if (!norm) return { translation: "", chunks: 0, engine: "ai", provider: null };
  if (source === target && difficulty === "medium") throw new Error("Source and target languages are the same (pick a reading level to rewrite instead).");
  const chunks = chunkNovel(norm, maxChunk);
  const pinned = pinnedFrom({ ai, chain });
  const results = new Array(chunks.length);
  const providers = new Set();

  const CONC = Math.max(1, Math.min(Number(concurrency || process.env.TRANSLATE_CONCURRENCY || 3), chunks.length));
  let next = 0;
  let failure = null;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (!failure) {
      const i = next++;
      if (i >= chunks.length) return;
      try {
        const r = await translateWithPolicy(chunks[i], {
          source, target, keepHonorifics, formality, glossary, notes, difficulty, pinned, fetchFn,
          providers: optsProviders,
          prevTail: results[i - 1]?.slice(-500) || "",
        });
        results[i] = r.text.trim();
        providers.add(`${r.provider}/${r.model}`);
        onProgress?.({ done: results.filter(Boolean).length, total: chunks.length });
      } catch (e) {
        failure = e;
        return;
      }
    }
  }));
  if (failure) throw failure;

  return { translation: joinChunks(results), chunks: chunks.length, engine: "ai", provider: [...providers].join(", ") || null };
}
