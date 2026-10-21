// Automatic quality checks on a translation (no extra model calls).
// Warnings are stored with the translation and surfaced in the UI, so problems
// are visible without anyone having to re-read every chapter.

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;
const KANA_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/g;
const CJK_TARGETS = new Set(["ja", "zh-CN", "zh-TW", "ko", "th", "my"]);
export const ENGLISH_OPENERS = new Set(`a an and are as at be been being but by can could did do does for from had has have he her him his i if in into is it its just like may might must of on or our she should so than that the their them then there these they this those to was we were well will with would you your think`.split(/\s+/));
// Valid Swedish sentence starters that collide with English openers.
export const SV_OPENER_EXCEPTIONS = new Set(["i", "just", "som", "att", "det", "den", "han", "hon", "vi", "de", "ett", "en"]);

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

const TRANSLATION_META_LINES = [
  /(?:^|\s)we need to (?:translate|preserve|copy)\b/i,
  /(?:^|\s)we must (?:translate|preserve|keep|leave|not change|not translate)\b/i,
  /(?:^|\s)follow(?: these)? rules\b(?=.*(?:translat|preserv|keep|glossary|paragraph|line break|untranslat))/i,
  /(?:^|\s)need to ensure\b.*(?:translation|glossary|paragraph|line break|untranslated)/i,
  /(?:^|\s)let's? (?:copy|translate|preserve|keep|break it|make sure|rewrite) each paragraph\b/i,
  /(?:^|\s)(?:now|here|below) (?:translate|we can translate|the translation|write)\b/i,
  /(?:^|\s)translate(?: the following| this passage| the passage(?: below)?)\b/i,
  /(?:^|\s)(?:here's?| here is|below is) (?:the )?translation\b/i,
  /(?:^|\s)(?:original text|swedish|translation)\s*:/i,
  /(?:^|\s)(?:this text is in english|the user (?:asked|wants))\b/i,
  /(?:^|\s)we should (?:translate|preserve|keep)\b/i,
  /(?:^|\s)(?:preserve|keep) (?:the )?(?:paragraph|line) breaks\b/i,
  /(?:^|\s)output only the translation\b/i,
  /(?:^|\s)keep(?:ing)? (?:the )?(?:glossary terms|paragraph breaks|line breaks|quotes?|honorifics?|names?|target-language quotation marks|lowercase|upper(?:case)?|original)\b/i,
  /(?:^|\s)keep as is\b/i,
  /(?:^|\s)keep \"[^\"]*\" as is\b/i,
  /(?:^|\s)(?:first|next|last) (?:paragraph|line)\s*:/i,
  /(?:^|\s)let's? (?:translate|rewrite) each paragraph\b/i,
  /(?:^|\s)(?:preserve|keep) (?:the )?(?:same|exact) (?:line|paragraph) breaks\b/i,
  /(?:^|\s)(?:we need to|we have to) translate to\b/i,
  /(?:^|\s)now (?:write|translate) (?:the )?translation\b/i,
  /(?:^|\s)(?:the following (?:is|text) (?:the )?translation|should we translate)\b/i,
  /(?:^|\s)(?:it's?|it'?s) likely a page header\b/i,
  /(?:^|\s)glossary includes specific terms\b/i,
  /(?:^|\s)keep lower case\b/i,
  /(?:^|\s)keep upper(?:case)?\b/i,
  /translate:.*?keep/i,
  /(?:^|\s)we'll(?:l)? (?:keep|translate)\b.*(?:as is|glossary|translation|untranslated|paragraph)/i,
  /(?:^|\s)we need to keep\b.*(?:as is|glossary|translation|untranslated|paragraph)/i,
  /(?:^|\s)the rule(?:s)?\s*:/i,
  /note:\s/i,
  /(?:^|\s)(?:opening|closing) quote style\b/i,
  /(?:^|\s)the original uses (?:double|single)?\s*(?:quotes?|punctuation|dialogue|dashes)/i,
  /(?:^|\s)translat\w* each line\b/i,
  /(?:^|\s)keep the (?:opening|closing|same) (?:quote|quotes|punctuation|style|dialogue)\b/i,
  /(?:^|\s)preserv\w* the original (?:text|punctuation|quotes?|formatting|dialogue)\b/i,
  /(?:^|\s)should we keep\b/i,
  /(?:^|\s)let's? copy each line and translate\b/i,
  /(?:^|\s)let's? copy each paragraph\b/i,
  /(?:^|\s)(?:note|question):\s/i,
  /(?:^|\s)(?:probably|maybe) translate\b/i,
  /(?:^|\s)(?:should|do we|would we) translate\b/i,
  /(?:^|\s)(?:keep|leave|not change|not translate) \"[^\"]*\"/i,
  /(?:^|\s)(?:if|when) \"[^\"]*\" (?:keep|leave|translate)/i,
  /(?:^|\s)(?:it'?s|it is) (?:likely|a|probably) (?:page|formatting|glossary|translation) (?:header|error|issue|artifact)/i,
  /(?:^|\s)(?:so|then) keep(?:ing)? (?:as is|the (?:paragraph|line|glossary|translation|names?|terms?|quotes?|original)\b)/i,
  /(?:^|\s)(?:thus|i will|i'll) (?:keep|translate|leave)\b.*(?:as is|glossary|translation|untranslated|paragraph)/i,
];

/** Remove obvious page headers and leaked translation instructions from novel text. */
export function cleanNovelArtifacts(text) {
  const sanitized = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    // Remove these labels whether they are standalone or glued to prose; the
    // capture retains adjacent content while normalizing the page boundary.
    .replace(/\n[ \t]*(?:Page|Sida)\s*\d+\s*Goldenagato\s*\|?[ \t]*(?=\n|$)/gi, "")
    .replace(/\n[ \t]*Page\s*\d+\s*[\w.-]+\.(?:com|net|org|io|me|co|ru|xyz|to)\s*\|?[ \t]*(?=\n|$)/gi, "")
    .replace(/^[ \t]*(?:Page|Sida)\s*\d+\s*Goldenagato\s*\|?[ \t]*(?=\n|$)/gim, "")
    .replace(/^[ \t]*Page\s*\d+\s*[\w.-]+\.(?:com|net|org|io|me|co|ru|xyz|to)\s*\|?[ \t]*(?=\n|$)/gim, "")
    .replace(/Page\s*\d+\s*Goldenagato\s*\|?/gi, " ")
    .replace(/Page\s*\d+\s*[\w.-]+\.(?:com|net|org|io|me|co|ru|xyz|to)\s*\|?/gi, " ")
    .replace(/^[ \t]*Page\s+\d+\s*$/gim, "")
    .replace(/^[ \t]*(?:Sida|Seite|Página|Pagina|Page)\s+\d+\s*\|?\s*$/gim, "")
    .replace(/\bPage\s*\d+\s*(?:Goldenagato|[\w.-]+\.(?:com|net|org|io|me|co|ru|xyz|to))\s*\|?/gi, " ")
    .replace(/\bSida\s*\d+\s*Goldenagato\s*\|?/gi, " ")
    .replace(/^(?:Page|Sida)\s*\d+Goldenagato\s*\|?[ \t]*$/gim, "")
    .replace(/^(?:Page|Sida)\s*\d+\s*[\w.-]+\.(?:com|net|org|io|me|co|ru|xyz|to)\s*\|?[ \t]*$/gim, "")
    .replace(/^(?:Page|Sida)\s*\d+\s+Goldenagato\s*\|?\s*$/gim, "")
    .split(/\n{2,}/);
  return sanitized
    .filter((paragraph) => {
      const trimmed = paragraph.trim();
      if (!trimmed) return false;
      return !TRANSLATION_META_LINES.some((pattern) => pattern.test(trimmed));
    })
    .join("\n\n")
    .replace(/\s*\n{3,}\s*/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Mechanical clean-up of leftover source artefacts in a non-CJK target:
 * CJK quote brackets → target quotes, and stray kana/hangul (particles like と)
 * removed. This runs after the model, and the lint below then re-checks.
 */
export function cleanTranslationArtifacts(text, target = "en") {
  let out = cleanNovelArtifacts(text);
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

function isWordChar(ch) { return !!ch && /[\p{L}\p{N}]/u.test(ch); }
function termOccurs(text, term) {
  const chars = [...String(text || "").toLocaleLowerCase()];
  const needle = [...String(term || "").toLocaleLowerCase()];
  if (!needle.length) return false;
  // CJK scripts do not separate words with spaces; exact substring matching is
  // appropriate there, while Latin words need boundaries to avoid e.g. chi/chil.
  if (needle.some((ch) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(ch))) {
    return String(text || "").toLocaleLowerCase().includes(String(term || "").toLocaleLowerCase());
  }
  for (let i = 0; i <= chars.length - needle.length; i++) {
    if (!needle.every((ch, j) => chars[i + j] === ch)) continue;
    if (!isWordChar(needle[0]) || (!isWordChar(chars[i - 1]) && !isWordChar(chars[i + needle.length]))) return true;
  }
  return false;
}

export function dedupeWarnings(warnings = []) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code || ""}|${warning.severity || ""}|${warning.detail || ""}|${warning.sample || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  // 2. Glossary terms should be distinctive names/concepts, not generic words.
  // Frequently auto-suggested terms such as "Sure" and "Like" are not reliably
  // expected verbatim in translation and caused noisy warnings.
  const ordinaryTerms = new Set(`a an and are as at be been being but by can could did do does for from had has have he her him his i if in into is it its just like may might must of on or our she should so than that the their them then there these they this those to was we were will with would you your well other sure let think`.split(/\s+/));
  const isOrdinary = (value) => {
    const words = String(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    return words.length > 0 && words.length <= 3 && words.every((word) => ordinaryTerms.has(word));
  };
  const missing = [];
  const normalize = (value) => String(value).toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
  const normalizedOutput = ` ${normalize(out)} `;
  for (const g of glossary || []) {
    if (!g.source || !g.target) continue;
    const source = String(g.source).trim();
    const targetTerm = String(g.target).trim();
    if (!source || !targetTerm || isOrdinary(source) || isOrdinary(targetTerm)) continue;
    if (!src.includes(source) || normalize(source) === normalize(targetTerm)) continue;
    // Discard punctuation in both strings, but require Latin terms to match as
    // a whole word; "Al" must not be accepted merely because output says "also".
    const normalizedTerm = normalize(targetTerm);
    const containsCjk = normalizedTerm.split("").some((char) => char.charCodeAt(0) > 0x2fff);
    if (normalizedTerm && (containsCjk ? normalize(out).includes(normalizedTerm) : normalizedOutput.includes(` ${normalizedTerm} `))) continue;
    missing.push(`${source}→${targetTerm}`);
  }
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length) {
    warnings.push({ code: "term-missing", severity: "warn", detail: `Expected distinctive term(s) missing: ${uniqueMissing.slice(0, 4).join(", ")}`, sample: uniqueMissing.slice(0, 4).join(", ") });
  }

  // 3. English discourse words copied at the start of Swedish sentences.
  // SV_OPENER_EXCEPTIONS are valid Swedish sentence starters ("i" = in,
  // "just" = precisely) that collide with English openers — flagging them
  // was a false positive on real Swedish prose.
  if (target === "sv") {
    const leaked = [];
    for (const sentence of out.split(/[.!?…]+|\n+/)) {
      const first = sentence.trim().match(/^[\u201c\"'(\[]*([A-Za-z]+)/)?.[1];
      if (first && !SV_OPENER_EXCEPTIONS.has(first.toLocaleLowerCase()) && ENGLISH_OPENERS.has(first.toLocaleLowerCase())) leaked.push(first);
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

  // 6. Check paired dialogue delimiters. Curly apostrophes in words such as
  // "don't" are punctuation, not dialogue quotes, and must not inflate counts.
  // Swedish convention uses ” on both sides (”citat”); a text with no “ and
  // an even number of ” is balanced, not "0 open, N unmatched close".
  const quotePairs = [["“", "”"], ["‘", "’"], ["«", "»"], ["「", "」"], ["『", "』"], ["\"", "\""]];
  const unmatched = [];
  for (const [open, close] of quotePairs) {
    if (open === "“" && !out.includes("“")) {
      // Swedish-style ”...” — even count means balanced.
      const closers = out.split("").filter((ch) => ch === "”").length;
      if (closers % 2 === 0) continue;
    }
    let depth = 0;
    let strayClose = 0;
    for (let i = 0; i < out.length; i++) {
      const char = out[i];
      // Ignore apostrophes embedded inside words and possessive endings.
      const previousIsWord = /[A-Za-z0-9À-ÖØ-öø-ÿ]/.test(out[i - 1] || "");
      const nextIsWord = /[A-Za-z0-9À-ÖØ-öø-ÿ]/.test(out[i + 1] || "");
      if (open === "‘" && char === close && previousIsWord && (depth === 0 || nextIsWord)) continue;
      if (open === "‘" && char === open && previousIsWord && nextIsWord) continue;
      if (open === close && char === open) depth = depth ? 0 : 1;
      else if (char === open) depth++;
      else if (char === close && depth > 0) depth--;
      else if (char === close) strayClose++;
    }
    if (depth || strayClose) unmatched.push(`${open}${close}: ${depth} open, ${strayClose} unmatched close`);
  }
  if (unmatched.length) warnings.push({ code: "quotes", severity: "warn", detail: `Unbalanced dialogue quotes (${unmatched.join("; ")}).` });

  // 7. Model commentary leaking into the output.
  if (/\b(here is the translation|as an ai|i cannot translate|note:)\b/i.test(out)) {
    warnings.push({ code: "commentary", severity: "warn", detail: "Output contains translator commentary instead of only the translation." });
  }

  return dedupeWarnings(warnings);
}

export function summarizeWarnings(warnings) {
  const unique = dedupeWarnings(warnings || []);
  const errors = unique.filter((w) => w.severity === "error").length;
  const warns = unique.filter((w) => w.severity === "warn").length;
  return { errors, warns, ok: errors === 0 };
}
