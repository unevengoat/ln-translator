// Term memory: one entry per original term, with a canonical form PER TARGET
// language. Operates on a plain terms object ({ [source]: term }) so it can live
// in its own per-story file (store.loadTerms/saveTerms).
//
// Rules the user asked for:
//  - Latin-script terms keep the original form automatically ("ideally the original").
//  - CJK/first-sight form: the model's first translation becomes canonical
//    (stability = the same input always maps to the same output).
//  - User corrections always win, and propagate to every chapter (library.correctTerm).
//  - "Vibe" adaptation (de-westernizing a misfit name) is a model + user decision;
//    the table only guarantees it then stays consistent everywhere.
import { parseGlossary } from "./glossary.js";

const KATAKANA_RUN = /[ァ-ヶー]{2,}/g;
const LATIN_NAME = /\b[A-ZÀ-Þ][a-zà-ÿ]{2,}(?:[ '\-][A-ZÀ-Þ][a-zà-ÿ]{2,})?/g;
export const isLatinText = (s) => /^[A-Za-zÀ-ÿ'’.\- ]+$/.test(s) && /[A-Za-zÀ-ÿ]/.test(s);

// Words that are capitalised only because of sentence position or formatting —
// never treat these as character/place names.
const STOPWORDS = new Set(`the and but for with from that this when chapter volume vol book part prologue epilogue
copyright translation translated cover art names any all his her its their our your my he she they we you i it
one two three first second third next last new old good bad great little big long short right left
yes no not now then there here what who whom whose which why how where when while because if so as at by
in on of to up down out over under again more most some such only own same than too very can will just
should could would may might must shall do does did done have has had having be been being am is are was were
about after before during into through between against without within along across behind beyond
thank thanks note notes page pages sign visit us or exclusive content
mister missus lord lady king queen prince princess saint sir madam
names name cover covers translation translated translations copyright vol vols volume volumes chapter chapters
part parts book books page number numbers edition press newsletter link links subscribe bonus content
mister madam sir novel novels author authors series story stories`.split(/\s+/).filter(Boolean));

/** Cheap candidates (no model call): katakana runs + Latin names. */
export function extractCandidates(text, cap = 120) {
  const found = new Map();
  const add = (s) => { s = s.trim(); if (s.length >= 2 && found.size < cap) found.set(s, (found.get(s) || 0) + 1); };
  for (const m of String(text).matchAll(KATAKANA_RUN)) add(m[0]);
  for (const m of String(text).matchAll(LATIN_NAME)) {
    if (!/^(The|And|But|For|With|From|That|This|When|Chapter)$/.test(m[0])) add(m[0]);
  }
  return [...found.keys()];
}

/**
 * Latin terms worth keeping: multi-word names, hyphenated/apostrophe names, or
 * anything that recurs. One-off capitalised words are sentence noise, not names.
 */
export function latinCandidates(text, cap = 120) {
  const counts = new Map();
  for (const m of String(text || "").matchAll(LATIN_NAME)) {
    const w = m[0].trim().replace(/\s+/g, " ");
    if (!isLatinText(w) || w.length < 3) continue;
    if (STOPWORDS.has(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([w, c]) => c >= 2 || /[-'’]/.test(w) || w.split(" ").length > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([w]) => w);
}

/** Latin terms are canonical as-is; others need a model/user decision. */
export function canonicalFor(source) {
  if (isLatinText(source)) return { canonical: source, auto: true };
  return { canonical: null, auto: false };
}

export { STOPWORDS };

/**
 * Bounded model call: ask how IT translated the proper names in this passage,
 * so the table records the story's actual usage for `lang`.
 */
export async function extractTermsWithModel(sourceSample, { source = "auto", target = "en", config, fetchFn = fetch }) {
  const { languageName } = await import("./prompt.js");
  const body = {
    model: config.model,
    temperature: 0,
    messages: [
      { role: "system", content: "You list proper names from a novel passage. Reply with ONLY a JSON array like " + '[{"source":"キリト","translation":"Kirito"}]. No commentary, no code fences.' },
      {
        role: "user",
        content:
          `Passage language: ${languageName(source)}. Target language: ${languageName(target)}.\n` +
          `List every person, place, country, organization, title and distinctive fictional term in the passage below ` +
          `with the form you would use when translating it to ${languageName(target)}. ` +
          `Skip ordinary words. Passage:\n\n${String(sourceSample).slice(0, 6000)}`,
      },
    ],
  };
  const res = await fetchFn(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...(config.headers || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 60000),
  });
  if (!res.ok) throw new Error(`term extraction HTTP ${res.status}`);
  const data = await res.json();
  const raw = String(data?.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  return arr.filter((e) => e && e.source && e.translation).map((e) => ({ source: String(e.source), translation: String(e.translation) }));
}

/** Merge model/user pairs into a terms object for `lang`. Returns how many were added. */
export function mergeTerms(terms, lang, pairs) {
  let added = 0;
  for (const pair of pairs || []) {
    const source = pair?.source;
    const translation = pair?.translation ?? pair?.target;
    if (!source || !translation) continue;
    const term = terms[source] || (terms[source] = { source, origin: "auto", at: Date.now(), langs: {} });
    const { canonical, auto } = canonicalFor(source);
    const slot = term.langs[lang] || (term.langs[lang] = { canonical: null, variants: [], origin: "auto", at: Date.now() });
    if (!slot.canonical) {
      slot.canonical = canonical || translation;
      if (canonical && canonical !== translation) slot.variants.push(translation);
      if (!auto) term.origin = "auto";
      added++;
    } else if (slot.canonical !== translation && !slot.variants.includes(translation)) {
      slot.variants.push(translation); // seen form, not canonical — replaced at assembly
    }
  }
  return added;
}

/** Glossary rows [{source, target}] for a language, longest-source-first. */
export function termsGlossary(terms, lang) {
  return Object.values(terms)
    .filter((t) => t.langs?.[lang]?.canonical)
    .map((t) => ({ source: t.source, target: t.langs[lang].canonical }))
    .sort((a, b) => b.source.length - a.source.length);
}

/** Canonical + all seen forms for a term in a language. */
export function termForms(term, lang) {
  const slot = term?.langs?.[lang];
  if (!slot) return [];
  return [slot.canonical, ...(slot.variants || [])].filter(Boolean);
}

/** Per-language counts, for stats. */
export function termCounts(terms) {
  const out = {};
  for (const t of Object.values(terms)) for (const lang of Object.keys(t.langs || {})) out[lang] = (out[lang] || 0) + 1;
  return out;
}

/**
 * Remove auto-discovered noise (common words wrongly captured as names) from a
 * term table, keeping every user-made term and anything with variants.
 */
export function cleanNoisyTerms(terms) {
  const removed = [];
  for (const [source, term] of Object.entries(terms)) {
    const auto = term.origin !== "user" && Object.values(term.langs || {}).every((l) => l.origin !== "user");
    const hasVariants = Object.values(term.langs || {}).some((l) => (l.variants || []).length);
    const canonicalSame = Object.values(term.langs || {}).every((l) => l.canonical === source);
    const short = source.length < 3;
    const stop = STOPWORDS.has(source.toLowerCase().trim());
    const looksLikeProse = source.split(/\s+/).length >= 4;
    if (auto && !hasVariants && (short || stop || (canonicalSame && looksLikeProse))) {
      delete terms[source];
      removed.push(source);
    }
  }
  return removed;
}

/* ---- bulk import/export (CSV or JSON) ---- */

export function termsToCsv(terms, lang) {
  const rows = [["source", "canonical"]];
  for (const t of Object.values(terms)) {
    const c = t.langs?.[lang]?.canonical;
    if (c) rows.push([t.source, c]);
  }
  return rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Accepts CSV ("source,canonical"), "a=b" lines, or JSON. Returns [{source, target}]. */
export function parseTermsInput(input, lang) {
  return parseGlossary(input);
}

export { parseGlossary };
