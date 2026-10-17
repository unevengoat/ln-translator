// Term memory: one entry per original term, with a canonical form PER TARGET
// language. Rules the user asked for:
//  - Latin-script terms keep the original form automatically ("ideally the original").
//  - CJK/first-sight form: the model's first translation becomes canonical
//    (stability = the same input always maps to the same output).
//  - User corrections always win, and propagate to every chapter (library.correctTerm).
//  - "Vibe" adaptation (de-westernizing a misfit name) is a model + user decision;
//    the table only guarantees it then stays consistent everywhere.
import { parseGlossary } from "./glossary.js";

const KATAKANA_RUN = /[ァ-ヶー]{2,}/g;
const LATIN_NAME = /\b[A-ZÀ-Þ][a-zà-ÿ]{2,}(?:[ '\-][A-ZÀ-Þ][a-zà-ÿ]{2,})?/g;
const isLatin = (s) => /^[A-Za-zÀ-ÿ'’.\- ]+$/.test(s) && /[A-Za-zÀ-ÿ]/.test(s);
export const isLatinText = isLatin;
export const latinCandidates = (text, cap = 120) => extractCandidates(text, cap).filter(isLatin);

const termKey = (workId, source) => `${workId} ${source}`;

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

/** Latin terms are canonical as-is; others need a model/user decision. */
export function canonicalFor(source) {
  if (isLatin(source)) return { canonical: source, auto: true };
  return { canonical: null, auto: false };
}

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
      {
        role: "system",
        content:
          "You list proper names from a novel passage. Reply with ONLY a JSON array like " +
          '[{"source":"キリト","translation":"Kirito"}]. No commentary, no code fences.',
      },
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
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(config.headers || {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs ?? 60000),
  });
  if (!res.ok) throw new Error(`term extraction HTTP ${res.status}`);
  const data = await res.json();
  const raw = String(data?.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  const slice = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const arr = JSON.parse(slice);
  return arr.filter((e) => e && e.source && e.translation).map((e) => ({ source: String(e.source), translation: String(e.translation) }));
}

/** Merge model/user pairs into the work's term table for `lang`. */
export function mergeTerms(db, workId, lang, pairs) {
  let added = 0;
  for (const { source, translation } of pairs || []) {
    if (!source || !translation) continue;
    const key = termKey(workId, source);
    let term = db.terms[key];
    if (!term) {
      term = db.terms[key] = { workId, source, origin: "auto", at: Date.now(), langs: {} };
    }
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

/** Glossary rows [{source, target}] for a work+lang, longest-source-first. */
export function termsGlossary(db, workId, lang) {
  return Object.values(db.terms)
    .filter((t) => t.workId === workId && t.langs?.[lang]?.canonical)
    .map((t) => ({ source: t.source, target: t.langs[lang].canonical }))
    .sort((a, b) => b.source.length - a.source.length);
}

/** Canonical + all seen forms for a term in a language. */
export function termForms(term, lang) {
  const slot = term?.langs?.[lang];
  if (!slot) return [];
  return [slot.canonical, ...(slot.variants || [])].filter(Boolean);
}

export { parseGlossary };
