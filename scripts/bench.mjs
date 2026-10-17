// Benchmark free-tier providers on the sample chapter.
// Keys ONLY from env vars — never put keys in this file.
//   GROQ_API_KEY=... CEREBRAS_API_KEY=... GEMINI_API_KEY=... OPENROUTER_API_KEY=... \
//   MISTRAL_API_KEY=... NVIDIA_API_KEY=... node scripts/bench.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { translateText } from "../src/engines/index.js";
import { PROVIDERS } from "../src/engines/providers.js";

import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(tmpdir(), "ln-bench");
await mkdir(OUT, { recursive: true });

const text = await readFile(path.join(ROOT, "samples", "chapter-ja.txt"), "utf8");
const glossary = await readFile(path.join(ROOT, "samples", "glossary.txt"), "utf8");

const MODELS = {
  groq: ["qwen/qwen3.8-27b"],
  cerebras: ["qwen-3.8-27b"],
  gemini: ["gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-3-flash-preview"],
  openrouter: ["google/gemma-4-31b-it:free"],
  mistral: ["mistral-small-latest"],
  nvidia: ["deepseek-ai/deepseek-v4.1-flash", "google/gemma-3-12b-it"],
  pollinations: ["openai"],
};

// Gemini's key format varies; if OpenAI-compat auth fails, try native REST shapes.
async function geminiNative(model, key, systemText, userText) {
  const bodies = [
    { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, headers: {} },
    { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { Authorization: `Bearer ${key}` } },
  ];
  const payload = { system_instruction: { parts: [{ text: systemText }] }, contents: [{ parts: [{ text: userText }] }] };
  const errors = [];
  for (const b of bodies) {
    try {
      const res = await fetch(b.url, { method: "POST", headers: { "Content-Type": "application/json", ...b.headers }, body: JSON.stringify(payload) });
      if (!res.ok) { errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`); continue; }
      const data = await res.json();
      const t = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
      if (t?.trim()) return t.trim();
      errors.push("empty content");
    } catch (e) { errors.push(e.message); }
  }
  throw new Error("gemini native failed: " + errors.join(" | "));
}

const results = [];
for (const [provider, models] of Object.entries(MODELS)) {
  const key = process.env[PROVIDERS[provider].keyEnv] || undefined;
  if (PROVIDERS[provider].needsKey && !key) {
    console.log(`\n### ${provider}: SKIPPED (no ${PROVIDERS[provider].keyEnv})`);
    continue;
  }
  let done = false;
  for (const model of models) {
    const t0 = Date.now();
    try {
      let translation, used;
      if (provider === "gemini") {
        try {
          ({ translation, provider: used } = await translateText(text, {
            source: "ja", target: "en", engine: "ai", glossary,
            ai: { provider, model, apiKey: key },
          }));
        } catch (compatErr) {
          // Fall back to native Gemini REST for this chunk set.
          const { buildSystemPrompt, buildUserMessage, languageName } = await import("../src/prompt.js");
          const { chunkNovel, joinChunks, normalizeText } = await import("../src/chunker.js");
          const chunks = chunkNovel(normalizeText(text), 1800);
          const sys = buildSystemPrompt({ sourceName: languageName("ja"), targetName: languageName("en"), keepHonorifics: true, glossary: (await import("../src/glossary.js")).parseGlossary(glossary) });
          const parts = [];
          for (const c of chunks) parts.push(await geminiNative(model, key, sys, buildUserMessage(c, parts.at(-1)?.slice(-500) || "")));
          translation = joinChunks(parts);
          used = `gemini-native/${model} (compat failed: ${compatErr.message.slice(0, 80)})`;
        }
      } else {
        ({ translation, provider: used } = await translateText(text, {
          source: "ja", target: "en", engine: "ai", glossary,
          ai: { provider, model, apiKey: key },
        }));
      }
      const ms = Date.now() - t0;
      const file = path.join(OUT, `${provider}.${model.replace(/[^a-z0-9]+/gi, "_")}.txt`);
      await writeFile(file, translation + "\n", "utf8");
      console.log(`\n### ${provider} / ${model} — OK in ${(ms / 1000).toFixed(1)}s (via ${used})\n${translation}`);
      results.push({ provider, model, ms, ok: true, file });
      done = true;
      break;
    } catch (e) {
      console.log(`\n### ${provider} / ${model} — FAILED: ${e.message.slice(0, 200)}`);
      results.push({ provider, model, ok: false, error: e.message.slice(0, 200) });
    }
  }
  if (!done) console.log(`>>> ${provider}: all models failed`);
}
console.log("\n\n=== SUMMARY ===");
for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.provider}/${r.model}${r.ok ? ` ${(r.ms / 1000).toFixed(1)}s` : " — " + r.error}`);
console.log(`Outputs saved to ${OUT}`);
