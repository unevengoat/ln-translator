// Novel-style prompt builder for the AI engine.
import { glossaryPromptLines, parseGlossary } from "./glossary.js";

export function buildSystemPrompt({ sourceName, targetName, keepHonorifics = true, formality = "match", glossary = [], notes = "" }) {
  const terms = glossaryPromptLines(glossary);
  const honorificLine = keepHonorifics
    ? "Keep Japanese/Korean/Chinese honorifics and suffixes (-san, -sama, -kun, -chan, -senpai, -sensei, oppa, hyung, etc.) and culturally specific terms untranslated/romanized where natural; never localize names."
    : "Localize naturally for the target language; drop honorifics unless needed for meaning.";
  const formalityLine =
    formality === "match"
      ? "Match the original register (polite/casual/archaic) per speaker."
      : `Use a consistently ${formality} register in the target language.`;
  return [
    `You are an expert light novel / web novel translator translating from ${sourceName} to ${targetName}.`,
    "Priorities: natural novel flow in the target language; faithful meaning, tone, POV, tense, and characterization.",
    "STRICT RULES:",
    "1. Output ONLY the translation. No explanations, no notes, no translator commentary.",
    "2. Preserve every paragraph break and line break exactly. Never merge or split paragraphs.",
    '3. Preserve dialogue formatting, inner monologue, emphasis, and onomatopoeia (naturalize SFX, e.g. ドキドキ -> "badump").',
    "4. Keep the same POV and tense as the original throughout.",
    `5. ${honorificLine}`,
    `6. ${formalityLine}`,
    terms.length ? `7. GLOSSARY (must follow exactly):\n${terms.join("\n")}` : null,
    "7. If a line is already in the target language or is untranslatable (system windows, stats), leave it as-is.",
    notes ? `STORY NOTES (from the translator, must follow):\n${notes}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/^7\. 7\./, "7.");
}

export function buildUserMessage(chunk, prevTail = "") {
  if (!prevTail) return `Translate the following passage:\n\n${chunk}`;
  return (
    `Previous passage's translation (for continuity of style/terms only, do NOT re-translate it):\n` +
    `<<<\n${prevTail}\n>>>\n\nTranslate ONLY the following new passage:\n\n${chunk}`
  );
}

export function languageName(code, fallback = code) {
  const map = {
    auto: "the source language (auto-detected)",
    en: "English",
    ja: "Japanese",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    ko: "Korean",
    es: "Spanish",
    fr: "French",
    de: "German",
    id: "Indonesian",
    th: "Thai",
    vi: "Vietnamese",
    ms: "Malay",
    tl: "Filipino",
    pt: "Portuguese",
    ru: "Russian",
    ar: "Arabic",
    hi: "Hindi",
    it: "Italian",
  };
  return map[code] || fallback || code;
}

export { parseGlossary };
