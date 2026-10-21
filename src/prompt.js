// Novel-style prompt builder for the AI engine.
import { glossaryPromptLines, parseGlossary } from "./glossary.js";

/** What each reading level means, for language learners. */
export const LEVEL_INSTRUCTIONS = {
  easy: "Write for a beginner (around A2). Use the simplest common words, short sentences, one idea per sentence, present/past simple tenses. Avoid idioms, rare words, subordinate clauses and figurative language. If the original is complex, split it into short clear sentences — meaning must stay the same.",
  medium: "Write natural, everyday prose (around B1–B2): normal vocabulary, varied but not complex sentences, common idioms allowed. This is the default novel style.",
  hard: "Write for an advanced reader (C1+): rich and precise vocabulary, complex and varied sentence structures, literary nuance, and any register the original carries. Do not simplify anything.",
};

export function buildSystemPrompt({ sourceName, targetName, keepHonorifics = true, formality = "match", glossary = [], notes = "", difficulty = "medium", sameLanguage = false }) {
  const terms = glossaryPromptLines(glossary);
  const level = LEVEL_INSTRUCTIONS[difficulty] || LEVEL_INSTRUCTIONS.medium;
  const honorificLine = keepHonorifics
    ? "Keep Japanese/Korean/Chinese honorifics and suffixes (-san, -sama, -kun, -chan, -senpai, -sensei, oppa, hyung, etc.) and culturally specific terms untranslated/romanized where natural; never localize names."
    : "Localize naturally for the target language; drop honorifics unless needed for meaning.";
  const formalityLine =
    formality === "match"
      ? "Match the original register (polite/casual/archaic) per speaker."
      : `Use a consistently ${formality} register in the target language.`;
  return [
    sameLanguage
      ? `You are an expert editor rewriting a text in ${targetName} at a specific reading level.`
      : `You are an expert light novel / web novel translator translating from ${sourceName} to ${targetName}.`,
    "Priorities: natural novel flow in the target language; faithful meaning, tone, POV, tense, and characterization.",
    "STRICT RULES:",
    "1. Output ONLY the translation. No explanations, no notes, no translator commentary, no discussion of these instructions, and no labels such as 'Paragraph 1' or 'Original text'.",
    "2. Preserve every paragraph break and line break exactly. Never merge or split paragraphs. Remove obvious scraped page headers/page numbers (for example 'Page 1Goldenagato |') rather than translating them.",
    '3. Preserve dialogue formatting, inner monologue, emphasis, and onomatopoeia (naturalize SFX, e.g. ドキドキ -> "badump").',
    "4. Keep the same POV and tense as the original throughout.",
    "5. NEVER leave any source-script character in the output (no kana, hangul, hanzi, particles like と/は/が). Convert 「」『』 to normal target-language quotation marks.",
    `6. ${honorificLine}`,
    `7. ${formalityLine}`,
    `8. READING LEVEL — ${difficulty.toUpperCase()}: ${level}`,
    "9. Proper names and glossary terms are IDENTICAL at every reading level — never simplify, translate or alter a name even at the easy level.",
    terms.length ? `10. GLOSSARY (must follow exactly):\n${terms.join("\n")}` : null,
    "11. If a line is already in the target language or is untranslatable (system windows, stats), leave it as-is.",
    notes ? `STORY NOTES (from the translator, must follow):\n${notes}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/^11\. 11\./, "11.");
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
