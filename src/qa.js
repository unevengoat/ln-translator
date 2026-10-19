// Automatic quality checks on a translation (no extra model calls).
// Warnings are stored with the translation and surfaced in the UI, so problems
// are visible without anyone having to re-read every chapter.

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const KANA_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_TARGETS = new Set(["ja", "zh-CN", "zh-TW", "ko", "th", "my"]);
const ENGLISH_OPENERS = new Set(`a an and are as at be been being but by can could did do does for from had has have he her him his i if in into is it its just like may might must of on or our she should so than that the their them then there these they this those to was we were well will with would you your think`.split(/\s+/));

/** Difficulty levels for the same chapter. Terms are shared; only wording changes. */
export const DIFFICULTIES = ["easy", "medium", "hard"];
export const DEFAULT_DIFFICULTY = "medium";

export function normalizeDifficulty(d) {
  const v = String(d || "").trim().toLowerCase();
  if (v === "simple" || v === "beginner" || v === "a2") return "easy";
  if (v === "advanced" || v === "c1" || v === "expert") return "hard";
  if (v === "normal" || v === "standard" || v === "b1" || v === "b2" || !v) return "medium";
  return DIFFICULTIES.includes(v) ? v : "medium";
}

/**
 * Mechanical clean-up of leftover source artefacts in a non-CJK target:
 * CJK quote brackets → target quotes, and stray kana/hangul (particles like と)
 * removed. This runs after the model, and the lint below then re-checks.
 */
export function cleanTranslationArtifacts(text, target = "en") {
  let out = String(text ?? "");
  if (CJK_TARGETS.has(target)) return out;
  out = out
    .replace(/「/g, "\u201c").replace(/」/g, "\u201d")
    .replace(/『/g, "\u2018").replace(/』/g, "\u2019")
    .replace(/[、]/g, ", ").replace(/[。]/g, ".")
    .replace(/[！]/g, "!").replace(/[？]/g, "?")
    .replace(/[（]/g, " (").replace(/[）]/g, ")")
    .replace(/[・]/g, " ");
  // Single stray kana/hangul characters are always artefacts in a Latin target.
  out = out.replace(/(^|[\s("'\u201c\u00ab])([\u3040-\u30ff\uac00-\ud7af]{1,2})(?=$|[\s)!"'\u201d\u00bb.,;:?])/g, "$1");
  out = out.replace(KANA_HANGUL, "");
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");
  // Broken quote at line starts ("and Asuna whispered" after a Japanese 「」と).
  out = out.replace(/([?!.\u2026])\s*"\s*and ([A-Z][a-z]+(?: [A-Z][a-z]+)?) (whispered|said|asked|shouted|replied|murmured|cried|laughed|sighed|nodded)/g, '$1" $2 $3');
  return out.trim();
}

export function lintTranslation(source, translation, { target = "en", glossary = [] } = {}) {
  const warnings = [];
  const src = String(source || "");
  const out = String(translation || "");

  if (!out.trim()) {
    warnings.push({ code: "empty", severity: "error", detail: "Translation is empty." });
    return warnings;
  }

  // 1. Untranslated source script left in a non-CJK target.
  if (!CJK_TARGETS.has(target)) {
    const leftovers = out.match(CJK) || [];
    if (leftovers.length > 0) {
      warnings.push({
        code: "source-script",
        severity: leftovers.length > 20 ? "error" : "warn",
        detail: `${leftovers.length} untranslated character(s) left in ${target} output.`,
        sample: [...new Set(leftovers)].slice(0, 12).join(""),
      });
    }
  }

  // 2. Glossary terms should be checked only when they actually contain a
  // distinctive name/term. Sentence-initial common words are not glossary QA.
  const ordinaryTerms = new Set(`a an and are as at be been being but by can could did do does for from had has have he her him his i if in into is it its just like may might must of on or our she should so than that the their them then there these they this those to was we were will with would you your well other mana`.split(/\s+/));
  const missing = [];
  const normalize = (value) => String(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const normalizedOutput = normalize(out);
  for (const g of glossary || []) {
    if (!g.source || !g.target) continue;
    const source = String(g.source).trim();
    const targetTerm = String(g.target).trim();
    if (!source || !targetTerm || ordinaryTerms.has(source.toLowerCase()) || ordinaryTerms.has(targetTerm.toLowerCase())) continue;
    if (!src.includes(source) || normalize(source) === normalize(targetTerm)) continue;
    // Be tolerant of case, punctuation and whitespace changes in model output.
    if (normalizedOutput.includes(normalize(targetTerm))) continue;
    missing.push(`${source}→${targetTerm}`);
  }
  if (missing.length) {
    warnings.push({ code: "term-missing", severity: "warn", detail: `Expected distinctive term(s) missing: ${[...new Set(missing)].slice(0, 4).join(", ")}`, sample: [...new Set(missing)].slice(0, 4).join(", ") });
  }

  // 3. English discourse words copied at the start of Swedish sentences.
  if (target === "sv") {
    const leaked = [];
    for (const sentence of out.split(/[.!?…]+|\n+/)) {
      const first = sentence.trim().match(/^[\u201c\"'(\[]*([A-Za-z]+)/)?.[1];
      if (first && ENGLISH_OPENERS.has(first.toLocaleLowerCase())) leaked.push(first);
    }
    if (leaked.length) warnings.push({ code: "english-opener", severity: "warn", detail: `Possible English sentence starter(s) in Swedish: ${[...new Set(leaked)].slice(0, 5).join(", ")}.`, sample: [...new Set(leaked)].slice(0, 5).join(", ") });
  }

  // 4. Suspiciously short output (dropped content).
  if (src.trim().length > 120 && out.trim().length < src.trim().length * 0.2) {
    warnings.push({ code: "too-short", severity: "error", detail: `Output looks too short (${out.trim().length} vs ${src.trim().length} source chars) — content may be missing.` });
  }

  // 5. Repeated-text loop (a classic LLM failure).
  const half = Math.floor(out.length / 2);
  if (out.length > 200 && out.slice(0, half).trim() === out.slice(half).trim()) {
    warnings.push({ code: "repetition", severity: "error", detail: "Output appears to repeat itself — likely a model loop." });
  }

  // 6. Check only straight double quotes. Curly/localized quote glyph usage
  // varies across providers and chapters, so comparing their types creates too
  // many false positives; single quotes/apostrophes are not dialogue delimiters.
  const straightQuotes = (out.match(/\"/g) || []).length;
  if (straightQuotes % 2) warnings.push({ code: "quotes", severity: "warn", detail: `Possible unmatched straight dialogue quote (${straightQuotes} marks).` });

  // 7. Model commentary leaking into the output.
  if (/\b(here is the translation|as an ai|i cannot translate|note:)\b/i.test(out)) {
    warnings.push({ code: "commentary", severity: "warn", detail: "Output contains translator commentary instead of only the translation." });
  }

  return warnings;
}

export function summarizeWarnings(warnings) {
  const errors = (warnings || []).filter((w) => w.severity === "error").length;
  const warns = (warnings || []).filter((w) => w.severity === "warn").length;
  return { errors, warns, ok: errors === 0 };
}
