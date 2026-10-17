// Library core: works (stories) → chapters → translations, translation memory,
// per-story model pinning and term propagation. Everything goes through Store,
// so the whole thing is one JSON db + text blobs and can be swapped for SQL later.
import { chunkNovel, normalizeText } from "./chunker.js";
import { sha256, uid } from "./store.js";
import { translateWithPolicy, PRIMARY } from "./engines/models.js";
import { resolveProvider } from "./engines/providers.js";
import { termsGlossary, mergeTerms, extractTermsWithModel, extractCandidates, latinCandidates, termForms } from "./terms.js";

export const MAX_CHUNK = 1800;
export const TERM_REF_LANG = "en"; // reference language for first-pass term discovery

const workKey = (title, author, sourceUrl) =>
  "w_" + sha256([sourceUrl || "", String(title || "").trim().toLowerCase(), String(author || "").trim().toLowerCase()].join("|")).slice(0, 24);

/**
 * Make sure a story has a term table for `lang` (one bounded Groq call + free
 * Latin candidates). Runs once per (story, language); grows the shared DB.
 */
export async function ensureTermsForLang(store, workId, lang, { fetchFn = fetch } = {}) {
  if (!lang) return 0;
  const db = await store.load();
  const work = db.works[workId];
  if (!work || work.termExtracted?.[lang]) return 0;
  const sample = await store.loadText(work.chapters[0]?.sourceHash || "").catch(() => "");
  // Latin originals are canonical in every language — cheap, always applied.
  let added = await store.update((d) => mergeTerms(d, workId, lang,
    latinCandidates(sample).map((c) => ({ source: c, translation: c }))));
  const key = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
  if (key && sample) {
    try {
      const pairs = await extractTermsWithModel(sample, {
        source: work.lang, target: lang,
        config: resolveProvider("groq", { model: PRIMARY.model, apiKey: key }), fetchFn,
      });
      added += await store.update((d) => mergeTerms(d, workId, lang, pairs));
      await store.update((d) => {
        const w = d.works[workId];
        if (w) w.termExtracted = { ...(w.termExtracted || {}), [lang]: true };
      });
    } catch (e) {
      // Leave the flag unset so a later request retries the discovery.
    }
  }
  return added;
}

/* ------------------------------------------------------------------ ingest */

/**
 * Ingest one chapter. Same story (title/author/url) reuses the same work id, so
 * re-uploads and extra chapters keep one shared term table. Never deletes:
 * re-uploading the same chapter at the same index stores a new version, and
 * identical text is recognised as a duplicate instead of being re-added.
 */
export async function ingestText(store, {
  title, author = "", sourceLang = "auto", sourceUrl = "",
  chapterTitle = "", chapterIndex = null, text,
  autoTranslateTo = [], fetchFn = fetch, translate = translateWithPolicy,
} = {}) {
  if (!title || !String(title).trim()) throw new Error("A story title is required.");
  const norm = normalizeText(text);
  if (!norm) throw new Error("The chapter text is empty.");
  const workId = workKey(title, author, sourceUrl);
  const bodyHash = sha256(norm);
  const sourceHash = await store.saveText(norm);

  const result = await store.update((db) => {
    let work = db.works[workId];
    if (!work) {
      work = db.works[workId] = {
        id: workId, title: String(title).trim(), author: String(author).trim(),
        lang: sourceLang || "auto", sourceUrl: sourceUrl || "",
        createdAt: Date.now(), chapters: [], languages: [], models: {},
      };
    }
    // Same chapter text already here? Recognise and reuse.
    const dup = work.chapters.find((c) => c.versions?.some((v) => v.hash === bodyHash));
    if (dup) return { workId, chapterId: dup.id, duplicate: true, created: false, work };

    const index = chapterIndex ?? (work.chapters.length + 1);
    const existing = work.chapters.find((c) => c.index === index);
    if (existing) {
      existing.versions.push({ hash: sourceHash, at: Date.now(), title: chapterTitle || existing.title });
      existing.sourceHash = sourceHash;
      existing.bodyHash = bodyHash;
      existing.updatedAt = Date.now();
      return { workId, chapterId: existing.id, created: false, version: true, work };
    }
    const id = uid("c");
    work.chapters.push({
      id, index, title: chapterTitle || `Chapter ${index}`, sourceHash, bodyHash,
      versions: [{ hash: sourceHash, at: Date.now() }], createdAt: Date.now(), updatedAt: Date.now(),
    });
    if (work.lang) work.languages = [...new Set([...work.languages, work.lang])];
    return { workId, chapterId: id, created: true, workCreated: true, work };
  });

  if (result.created) {
    // Latin candidates are canonical as-is, for the reference language.
    const out = await store.update((db) => mergeTerms(db, workId, TERM_REF_LANG,
      latinCandidates(norm).map((c) => ({ source: c, translation: c }))));
    result.termsAdded = out;
    // Best-effort model term discovery (Groq). Never fatal.
    try {
      const key = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
      if (key) {
        const pairs = await extractTermsWithModel(norm, {
          source: sourceLang || "auto", target: TERM_REF_LANG,
          config: resolveProvider("groq", { model: PRIMARY.model, apiKey: key }),
          fetchFn,
        });
        result.termsAdded += await store.update((db) => mergeTerms(db, workId, TERM_REF_LANG, pairs));
      }
    } catch (e) {
      result.termExtraction = "skipped: " + e.message.slice(0, 120);
    }
  }

  for (const target of autoTranslateTo) {
    if (!target || target === (sourceLang || "")) continue;
    try {
      await translateChapter(store, { workId, chapterId: result.chapterId, target, fetchFn, translate });
      result.translated = [...(result.translated || []), target];
    } catch (e) {
      result.translateError = (result.translateError || "") + ` ${target}: ${e.message.slice(0, 120)}`;
    }
  }
  return result;
}

/* -------------------------------------------------------------- translation */

/**
 * Translate (or re-translate) one chapter. Chunk-keyed translation memory means
 * an identical chapter is never paid for twice, and the story's model stays
 * pinned; a replacement is only chosen when the pinned model is gone.
 */
export async function translateChapter(store, {
  workId, chapterId, target, force = false, strict = true, fetchFn = fetch, translate = translateWithPolicy, onProgress,
} = {}) {
  if (!target) throw new Error("A target language is required.");
  const db0 = await store.load();
  const work = db0.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const chapter = db0.chapters[chapterId] || work.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error("Unknown chapter: " + chapterId);
  if (target === work.lang) throw new Error("Source and target languages are the same.");

  // Grow this story's glossary for the target language (once per story+lang).
  await ensureTermsForLang(store, workId, target, { fetchFn });
  const db1 = await store.load();
  const text = await store.loadText(chapter.sourceHash);
  const chunks = chunkNovel(normalizeText(text), MAX_CHUNK);
  const glossary = termsGlossary(db1, workId, target);
  let pinned = db1.works[workId]?.models?.[target] || null;
  const results = [];
  const todo = [];
  chunks.forEach((c, i) => {
    const hit = db1.tm[`${workId}|${target}|${sha256(c)}`];
    if (hit && !force) results[i] = hit.text;
    else todo.push(i);
  });

  let provider = pinned ? `${pinned.provider}/${pinned.model}` : null;
  for (const i of todo) {
    const r = await translate(chunks[i], {
      source: work.lang, target, glossary, prevTail: results[i - 1]?.slice(-500) || "",
      pinned, fetchFn, strict,
    });
    results[i] = r.text.trim();
    provider = `${r.provider}/${r.model}`;
    pinned = { provider: r.provider, model: r.model };
    // Persist progress per chunk so a crash mid-chapter doesn't lose work.
    await store.update((db) => {
      db.tm[`${workId}|${target}|${sha256(chunks[i])}`] = { text: results[i], at: Date.now() };
      if (db.works[workId]) db.works[workId].models = { ...(db.works[workId].models || {}), [target]: pinned };
    });
    onProgress?.({ done: todo.indexOf(i) + 1, total: todo.length });
  }

  const translation = results.filter((v) => v !== undefined).join("\n\n");
  const hash = await store.saveText(translation);
  const key = `${workId}|${chapterId}|${target}`;
  await store.update((db) => {
    db.translations[key] = { key, workId, chapterId, target, hash, chunks: chunks.length, at: Date.now() };
    const w = db.works[workId];
    if (w) w.languages = [...new Set([...w.languages, target])];
  });
  return { translation, chunks: chunks.length, cached: todo.length === 0, provider };
}

/* ------------------------------------------------------------------- reads */

export async function listWorks(store, { q = "" } = {}) {
  const db = await store.load();
  const needle = q.trim().toLowerCase();
  return Object.values(db.works)
    .filter((w) => !needle || w.title.toLowerCase().includes(needle) || w.author.toLowerCase().includes(needle) || w.lang.includes(needle))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((w) => ({
      ...w,
      chapterCount: w.chapters.length,
      translatedCount: Object.values(db.translations).filter((t) => t.workId === w.id).length,
    }));
}

export async function getWork(store, workId) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) return null;
  const chapters = work.chapters
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      ...c,
      translations: Object.values(db.translations)
        .filter((t) => t.chapterId === c.id)
        .map((t) => t.target),
      versionCount: c.versions?.length || 1,
    }));
  const terms = Object.values(db.terms).filter((t) => t.workId === workId);
  return { ...work, chapters, terms, translatedCount: chapters.reduce((n, c) => n + c.translations.length, 0) };
}

export async function getChapter(store, { workId, chapterId, lang = "" }) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) return null;
  const chapter = work.chapters.find((c) => c.id === chapterId || String(c.index) === String(chapterId));
  if (!chapter) return null;
  const original = await store.loadText(chapter.sourceHash).catch(() => "");
  const available = Object.values(db.translations).filter((t) => t.chapterId === chapter.id).map((t) => t.target);
  let translation = null;
  if (lang && lang !== work.lang) {
    const rec = db.translations[`${workId}|${chapter.id}|${lang}`];
    if (rec) translation = await store.loadText(rec.hash).catch(() => null);
  }
  return { work, chapter, original, translation, available, lang: work.lang };
}

export async function stats(store) {
  const db = await store.load();
  const works = Object.values(db.works);
  const translations = Object.values(db.translations);
  return {
    works: works.length,
    chapters: works.reduce((n, w) => n + w.chapters.length, 0),
    translations: translations.length,
    terms: Object.keys(db.terms).length,
    tmSegments: Object.keys(db.tm).length,
    languages: [...new Set([...works.map((w) => w.lang), ...translations.map((t) => t.target)])].filter(Boolean).sort(),
  };
}

/* ------------------------------------------------------------ user corrections */

/**
 * Correct/rename a term. Rewrites the stored translation of EVERY chapter of
 * that story in that language, plus the translation memory, so the old form
 * can never come back. No manual re-translation needed.
 */
export async function correctTerm(store, { workId, lang, source, canonical, forms = [] } = {}) {
  if (!workId || !lang || !source) throw new Error("workId, lang and source are required.");
  await store.load();
  const key = `${workId} ${source}`;
  const before = store.db.terms[key];
  const olds = [...new Set([...(forms || []), ...termForms(before, lang)])].filter((o) => o && o !== canonical);

  await store.update((db) => {
    const t = db.terms[key] || (db.terms[key] = { workId, source, origin: "user", at: Date.now(), langs: {} });
    const slot = t.langs[lang] || (t.langs[lang] = { canonical: null, variants: [], origin: "user", at: Date.now() });
    slot.variants = [...new Set([...(slot.variants || []), ...olds])].filter((v) => v !== canonical);
    slot.canonical = canonical;
    slot.origin = "user";
    slot.at = Date.now();
    t.origin = "user";
  });

  const replace = (text) => {
    let out = text;
    for (const o of olds) if (o && out.includes(o)) out = out.replaceAll(o, canonical);
    return out;
  };

  // 1. translation memory
  const tmFixes = [];
  for (const [k, v] of Object.entries(store.db.tm)) {
    if (!k.startsWith(`${workId}|${lang}|`)) continue;
    const next = replace(v.text);
    if (next !== v.text) tmFixes.push([k, { ...v, text: next, at: Date.now() }]);
  }
  if (tmFixes.length) await store.update((db) => tmFixes.forEach(([k, v]) => { db.tm[k] = v; }));

  // 2. saved chapter translations
  let chapterRewrites = 0;
  const rewrites = [];
  for (const [k, tr] of Object.entries(store.db.translations)) {
    if (tr.workId !== workId || tr.target !== lang) continue;
    const text = await store.loadText(tr.hash).catch(() => null);
    if (text == null) continue;
    const next = replace(text);
    if (next !== text) {
      rewrites.push([k, await store.saveText(next)]);
      chapterRewrites++;
    }
  }
  if (rewrites.length) await store.update((db) => rewrites.forEach(([k, h]) => { if (db.translations[k]) db.translations[k].hash = h; }));

  return {
    term: store.db.terms[key],
    tmRewrites: tmFixes.length,
    chapterRewrites,
    summary: `Updated "${canonical}" in ${chapterRewrites} saved translation(s) and ${tmFixes.length} memory segment(s). No re-translation needed.`,
  };
}

/** Suggest terms for a story: what the model actually produced + glossary view. */
export async function suggestTerms(store, { workId, lang = "en", fetchFn = fetch } = {}) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const existing = Object.values(db.terms).filter((t) => t.workId === workId && t.langs?.[lang]);
  const known = new Set(existing.map((t) => t.source));
  const text = await store.loadText(work.chapters[0].sourceHash).catch(() => "");
  const candidates = extractCandidates(text).filter((c) => !known.has(c));
  let modelPairs = [];
  try {
    const key = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
    if (key && text) {
      modelPairs = await extractTermsWithModel(text, {
        source: work.lang, target: lang,
        config: resolveProvider("groq", { model: PRIMARY.model, apiKey: key }), fetchFn,
      });
    }
  } catch { /* ignore */ }
  return {
    terms: existing.map((t) => ({
      source: t.source, canonical: t.langs[lang].canonical,
      origin: t.langs[lang].origin, variants: t.langs[lang].variants,
    })),
    candidates: candidates.map((c) => ({ source: c, suggested: c })),
    modelTerms: modelPairs.filter((p) => !known.has(p.source)),
  };
}
