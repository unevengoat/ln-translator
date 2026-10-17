// Automatic quality checks on a translation (no extra model calls).
// Warnings are stored with the translation and surfaced in the UI, so problems
// are visible without anyone having to re-read every chapter.

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const KANA_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_TARGETS = new Set(["ja", "zh-CN", "zh-TW", "ko", "th", "my"]);

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

  // 2. Glossary terms that appear in the source but not in the output.
  const missing = [];
  for (const g of glossary || []) {
    if (g.source && g.target && src.includes(g.source) && !out.includes(g.target)) missing.push(`${g.source}→${g.target}`);
  }
  if (missing.length) {
    warnings.push({ code: "term-missing", severity: "warn", detail: `Expected term(s) missing from output: ${missing.slice(0, 6).join(", ")}`, sample: missing.slice(0, 6).join(", ") });
  }

  // 3. Suspiciously short output (dropped content).
  if (src.trim().length > 120 && out.trim().length < src.trim().length * 0.2) {
    warnings.push({ code: "too-short", severity: "error", detail: `Output looks too short (${out.trim().length} vs ${src.trim().length} source chars) — content may be missing.` });
  }

  // 4. Repeated-text loop (a classic LLM failure).
  const half = Math.floor(out.length / 2);
  if (out.length > 200 && out.slice(0, half).trim() === out.slice(half).trim()) {
    warnings.push({ code: "repetition", severity: "error", detail: "Output appears to repeat itself — likely a model loop." });
  }

  // 5. Unbalanced quotes (formatting damage).
  const pairs = [['"', '"'], ["\u201c", "\u201d"], ["\u00ab", "\u00bb"], ["\u300c", "\u300d"], ["\u2018", "\u2019"]];
  for (const [open, close] of pairs) {
    const a = (out.match(new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const b = (out.match(new RegExp(close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (open !== close && a !== b) warnings.push({ code: "quotes", severity: "warn", detail: `Unbalanced ${open}${close} quotes (${a} vs ${b}).` });
  }

  // 6. Model commentary leaking into the output.
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
