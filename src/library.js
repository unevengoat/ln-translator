// Library core: works (stories) → chapters → translations, per-story terms,
// translation memory, model pinning, QA warnings, activity feed and corrections.
// All persistence goes through Store (local disk / R2 / GitHub), so the same
// code works in dev and on a free host with durable storage.
import { chunkNovel, normalizeText } from "./chunker.js";
import { sha256, uid } from "./store.js";
import { translateWithPolicy, PRIMARY } from "./engines/models.js";
import { resolveProvider } from "./engines/providers.js";
import {
  termsGlossary, mergeTerms, extractTermsWithModel, latinCandidates, termForms,
  termCounts, termsToCsv, parseCsv, parseGlossary,
} from "./terms.js";
import { lintTranslation, summarizeWarnings } from "./qa.js";

export const MAX_CHUNK = 1800;
export const TERM_REF_LANG = "en"; // reference language for first-pass term discovery
const ACTIVITY_CAP = 500;
const DEFAULT_SETTINGS = { keepHonorifics: true, formality: "match", notes: "" };

const workKey = (title, author, sourceUrl) =>
  "w_" + sha256([sourceUrl || "", String(title || "").trim().toLowerCase(), String(author || "").trim().toLowerCase()].join("|")).slice(0, 24);

/** The id a story will have for these details (respects renames via the index). */
export async function workIdFor(store, { title, author = "", sourceUrl = "" }) {
  const db = await store.load();
  return db.workIndex[workKey(title, author, sourceUrl)] || workKey(title, author, sourceUrl);
}

function logActivity(db, entry) {
  db.activity = db.activity || [];
  db.activity.push({ at: Date.now(), ...entry });
  if (db.activity.length > ACTIVITY_CAP) db.activity = db.activity.slice(-ACTIVITY_CAP);
}

const newWork = (id, { title, author, sourceLang, sourceUrl }) => ({
  id, title: String(title).trim(), author: String(author || "").trim(),
  lang: sourceLang || "auto", sourceUrl: sourceUrl || "",
  createdAt: Date.now(), updatedAt: Date.now(),
  chapters: [], volumes: [], languages: [], models: {}, settings: { ...DEFAULT_SETTINGS },
  terms: {}, tmSegments: {}, usage: { calls: 0, chunks: 0, byModel: {} }, termExtracted: {},
});

/* ------------------------------------------------------- chapters / splitting */

// Note: no \b — it never matches after a CJK character (話 is not a "word" char).
const CHAPTER_MARKER = /^\s*(?:第\s*\d+\s*[章話话節节回]|chapter\s+\d+|ch\.?\s*\d+)(?:[\s:：.。\-—]|$)/i;
const VOLUME_MARKER = /^\s*(?:(?:volume|vol\.?|book)\s*\d+(?:[\s:：.\-—]|$)|\d+\s*巻(?:[\s:：.。\-—]|$)|第\s*\d+\s*[巻卷](?:[\s:：.。\-—]|$))/i;

export const volumeLabel = (v) => String(v ?? "").trim();
export const volumeKeyOf = (label) => volumeLabel(label).replace(/\s+/g, " ").toLowerCase();

/** Find or create a volume entry, returning its key. */
export function ensureVolume(work, label) {
  const key = volumeKeyOf(label);
  work.volumes = work.volumes || [];
  let vol = work.volumes.find((v) => v.key === key);
  if (!vol) {
    vol = { key, label: volumeLabel(label), order: work.volumes.length, createdAt: Date.now() };
    work.volumes.push(vol);
  }
  return vol;
}

/** Chapters ordered by volume, then chapter index. */
export function sortChapters(work) {
  const order = new Map((work.volumes || []).map((v) => [v.key, v.order]));
  return [...work.chapters].sort((a, b) => {
    const av = order.get(a.volumeKey || "") ?? 0;
    const bv = order.get(b.volumeKey || "") ?? 0;
    return av - bv || (a.index || 0) - (b.index || 0);
  });
}

/**
 * Split a big paste into volumes and chapters on common markers
 * (English + CJK): "Volume 1", "Vol. 2", "第1巻", "第1話", "Chapter 3".
 */
export function splitChapters(text, { defaultVolume = "" } = {}) {
  const norm = normalizeText(text);
  if (!norm) return [];
  const parts = [];
  let volume = volumeLabel(defaultVolume);
  let current = null;
  const flush = () => { if (current) parts.push(current); current = null; };
  for (const line of norm.split("\n")) {
    if (VOLUME_MARKER.test(line)) { flush(); volume = line.trim(); continue; }
    if (CHAPTER_MARKER.test(line)) { flush(); current = { volume, title: line.trim(), lines: [] }; continue; }
    if (!current) current = { volume, title: "", lines: [] };
    current.lines.push(line);
  }
  flush();
  const chapters = parts
    .map((p, i) => ({ volume: p.volume, title: p.title || `Chapter ${i + 1}`, text: p.lines.join("\n").trim() }))
    .filter((c) => c.text);
  return chapters.length ? chapters : [{ volume: volumeLabel(defaultVolume), title: "", text: norm }];
}

/* ------------------------------------------------------------------- terms */

export async function ensureTermsForLang(store, workId, lang, { fetchFn = fetch } = {}) {
  if (!lang) return 0;
  const db = await store.load();
  const work = db.works[workId];
  if (!work || work.termExtracted?.[lang]) return 0;
  const sample = await store.loadText(work.chapters[0]?.sourceHash || "").catch(() => "");
  const terms = await store.loadTerms(workId);
  // Latin originals are canonical in every language — cheap, always applied.
  let added = mergeTerms(terms, lang, latinCandidates(sample).map((c) => ({ source: c, translation: c })));
  const key = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
  if (key && sample) {
    try {
      const pairs = await extractTermsWithModel(sample, {
        source: work.lang, target: lang,
        config: resolveProvider("groq", { model: PRIMARY.model, apiKey: key }), fetchFn,
      });
      added += mergeTerms(terms, lang, pairs);
      store.saveTerms(workId, terms);
      await store.update((d) => {
        const w = d.works[workId];
        if (w) {
          w.termExtracted = { ...(w.termExtracted || {}), [lang]: true };
          w.terms = termCounts(terms);
        }
      });
    } catch { /* leave unset so a later request retries */ }
  }
  return added;
}

/* ------------------------------------------------------------------ ingest */

export async function ingestText(store, {
  title, author = "", sourceLang = "auto", sourceUrl = "",
  chapterTitle = "", chapterIndex = null, volume = "", text,
  autoTranslateTo = [], settings = {}, fetchFn = fetch, translate = translateWithPolicy, flush = true,
} = {}) {
  if (!title || !String(title).trim()) throw new Error("A story title is required.");
  const norm = normalizeText(text);
  if (!norm) throw new Error("The chapter text is empty.");
  const key = workKey(title, author, sourceUrl);
  const bodyHash = sha256(norm);
  const sourceHash = await store.saveText(norm);

  const result = await store.update((db) => {
    const existingId = db.workIndex[key];
    const workId = existingId || workKey(title, author, sourceUrl);
    if (!existingId) db.workIndex[key] = workId;
    if (!db.works[workId]) {
      db.works[workId] = { ...newWork(workId, { title, author, sourceLang, sourceUrl }), settings: { ...DEFAULT_SETTINGS, ...settings } };
    }
    const work = db.works[workId];
    if (Object.keys(settings).length) work.settings = { ...DEFAULT_SETTINGS, ...work.settings, ...settings };

    const dup = work.chapters.find((c) => c.versions?.some((v) => v.hash === bodyHash));
    if (dup) return { workId, chapterId: dup.id, duplicate: true, created: false };

    // Volumes are just labels; a chapter is identified by (volume, index).
    const vol = ensureVolume(work, volume);
    const inVolume = work.chapters.filter((c) => (c.volumeKey || "") === vol.key);
    const index = chapterIndex != null && chapterIndex !== "" ? parseInt(chapterIndex, 10) : inVolume.length + 1;
    const atIndex = inVolume.find((c) => c.index === index);
    if (atIndex) {
      atIndex.versions.push({ hash: sourceHash, at: Date.now(), title: chapterTitle || atIndex.title });
      atIndex.sourceHash = sourceHash;
      atIndex.bodyHash = bodyHash;
      atIndex.updatedAt = Date.now();
      work.updatedAt = Date.now();
      logActivity(db, { type: "chapter-version", workId, chapterId: atIndex.id, detail: atIndex.title, lang: work.lang });
      return { workId, chapterId: atIndex.id, created: false, version: true, volume: vol.label };
    }
    const id = uid("c");
    work.chapters.push({
      id, index, title: chapterTitle || `Chapter ${index}`, volumeKey: vol.key, volume: vol.label,
      sourceHash, bodyHash, versions: [{ hash: sourceHash, at: Date.now() }], createdAt: Date.now(), updatedAt: Date.now(),
    });
    work.languages = [...new Set([...work.languages, work.lang])];
    work.updatedAt = Date.now();
    logActivity(db, { type: "chapter-added", workId, chapterId: id, detail: `${vol.label ? vol.label + " · " : ""}${chapterTitle || `Chapter ${index}`}`, lang: work.lang });
    return { workId, chapterId: id, created: true, workCreated: true, volume: vol.label };
  });

  if (result.created) {
    // Fast, no model calls: Latin terms are canonical as-is. Language-specific
    // terms are discovered later, per target language, during translation.
    const terms = await store.loadTerms(result.workId);
    result.termsAdded = mergeTerms(terms, TERM_REF_LANG, latinCandidates(norm).map((c) => ({ source: c, translation: c })));
    store.saveTerms(result.workId, terms);
    await store.update((d) => { const w = d.works[result.workId]; if (w) w.terms = termCounts(terms); });
    if (flush) await store.flush();
  }

  for (const target of autoTranslateTo) {
    if (!target || target === (sourceLang || "")) continue;
    try {
      await translateChapter(store, { workId: result.workId, chapterId: result.chapterId, target, fetchFn, translate });
      result.translated = [...(result.translated || []), target];
    } catch (e) {
      result.translateError = (result.translateError || "") + ` ${target}: ${e.message.slice(0, 160)}`;
    }
  }
  return result;
}

/** Ingest a multi-chapter paste or a list of {title, text}. */
export async function bulkIngest(store, {
  title, author = "", sourceLang = "auto", sourceUrl = "", text, chapters, volume = "",
  autoTranslateTo = [], settings = {}, fetchFn = fetch, translate = translateWithPolicy,
} = {}) {
  const list = chapters?.length ? chapters : splitChapters(text, { defaultVolume: volume });
  const out = [];
  let workId = null;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const r = await ingestText(store, {
      title, author, sourceLang, sourceUrl,
      chapterTitle: c.title || `Chapter ${i + 1}`, chapterIndex: null,
      volume: c.volume ?? volume ?? "",
      text: c.text, autoTranslateTo: [], settings, fetchFn, translate, flush: false,
    });
    workId = r.workId;
    out.push({ chapterId: r.chapterId, title: c.title || `Chapter ${i + 1}`, volume: r.volume || "", created: r.created, duplicate: !!r.duplicate, version: !!r.version });
  }
  // One storage write for the whole batch instead of one per chapter.
  await store.flush();
  const translated = [];
  for (const target of autoTranslateTo) {
    if (!target || target === sourceLang) continue;
    for (const c of out) {
      try {
        await translateChapter(store, { workId, chapterId: c.chapterId, target, fetchFn, translate });
        translated.push(`${c.title}→${target}`);
      } catch { /* keep going with the rest */ }
    }
  }
  return { workId, chapters: out, translated };
}

/* -------------------------------------------------------------- translation */

export async function translateChapter(store, {
  workId, chapterId, target, force = false, fetchFn = fetch, translate = translateWithPolicy, onProgress,
} = {}) {
  if (!target) throw new Error("A target language is required.");
  const db0 = await store.load();
  const work = db0.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const chapter = work.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error("Unknown chapter: " + chapterId);
  if (target === work.lang) throw new Error("Source and target languages are the same.");

  await ensureTermsForLang(store, workId, target, { fetchFn });
  const settings = { ...DEFAULT_SETTINGS, ...(work.settings || {}) };
  const terms = await store.loadTerms(workId);
  const glossary = termsGlossary(terms, target);
  const tm = await store.loadTm(workId, target);
  const text = await store.loadText(chapter.sourceHash);
  const chunks = chunkNovel(normalizeText(text), MAX_CHUNK);

  let pinned = work.models?.[target] || null;
  const results = [];
  const todo = [];
  chunks.forEach((c, i) => {
    const hit = tm[sha256(c)];
    if (hit && !force) results[i] = hit.text;
    else todo.push(i);
  });

  const warnings = [];
  let provider = pinned ? `${pinned.provider}/${pinned.model}` : null;
  for (let n = 0; n < todo.length; n++) {
    const i = todo[n];
    const r = await translate(chunks[i], {
      source: work.lang, target, glossary, prevTail: results[i - 1]?.slice(-500) || "",
      pinned, fetchFn, keepHonorifics: settings.keepHonorifics, formality: settings.formality, notes: settings.notes,
    });
    results[i] = r.text.trim();
    warnings.push(...lintTranslation(chunks[i], results[i], { target, glossary }));
    provider = `${r.provider}/${r.model}`;
    pinned = { provider: r.provider, model: r.model };
    tm[sha256(chunks[i])] = { text: results[i], at: Date.now() };
    store.saveTm(workId, target, tm);
    await store.update((db) => {
      const w = db.works[workId];
      if (!w) return;
      w.models = { ...(w.models || {}), [target]: pinned };
      w.usage = w.usage || { calls: 0, chunks: 0, byModel: {} };
      w.usage.calls++;
      w.usage.chunks++;
      const mk = `${r.provider}/${r.model}`;
      w.usage.byModel[mk] = (w.usage.byModel[mk] || 0) + 1;
    });
    onProgress?.({ done: n + 1, total: todo.length });
  }

  const translation = results.filter((v) => v !== undefined).join("\n\n");
  const hash = await store.saveText(translation);
  const tkey = `${workId}|${chapterId}|${target}`;
  await store.update((db) => {
    const w = db.works[workId];
    db.translations[tkey] = {
      key: tkey, workId, chapterId, target, hash, chunks: chunks.length, at: Date.now(),
      provider, warnings, qa: summarizeWarnings(warnings),
    };
    if (w) {
      w.languages = [...new Set([...w.languages, target])];
      w.updatedAt = Date.now();
      w.tmSegments = { ...(w.tmSegments || {}), [target]: Object.keys(tm).length };
    }
    logActivity(db, { type: "translated", workId, chapterId, lang: target, detail: `${chapter.title} → ${target}` });
  });
  await store.flush();
  return { translation, chunks: chunks.length, cached: todo.length === 0, provider, warnings, qa: summarizeWarnings(warnings) };
}

/** Translate every chapter of a story into a language (resumable, keeps going). */
export async function translateWholeStory(store, { workId, target, force = false, fetchFn = fetch, translate = translateWithPolicy, onProgress } = {}) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const chapters = [...work.chapters].sort((a, b) => a.index - b.index);
  const out = [];
  for (let i = 0; i < chapters.length; i++) {
    try {
      const r = await translateChapter(store, { workId, chapterId: chapters[i].id, target, force, fetchFn, translate });
      out.push({ chapterId: chapters[i].id, title: chapters[i].title, ok: true, cached: r.cached, qa: r.qa });
    } catch (e) {
      out.push({ chapterId: chapters[i].id, title: chapters[i].title, ok: false, error: e.message.slice(0, 200) });
    }
    onProgress?.({ done: i + 1, total: chapters.length, title: chapters[i].title });
  }
  return { target, chapters: out, ok: out.filter((c) => c.ok).length, failed: out.filter((c) => !c.ok).length };
}

/* ------------------------------------------------------------------- reads */

export async function listWorks(store, { q = "", limit = 200 } = {}) {
  const db = await store.load();
  const needle = q.trim().toLowerCase();
  return Object.values(db.works)
    .filter((w) => !needle || w.title.toLowerCase().includes(needle) || w.author.toLowerCase().includes(needle) || w.lang.includes(needle))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit)
    .map((w) => ({
      ...w,
      chapterCount: w.chapters.length,
      volumeCount: (w.volumes || []).filter((v) => v.label).length,
      translatedCount: Object.values(db.translations).filter((t) => t.workId === w.id).length,
      warnings: Object.values(db.translations).filter((t) => t.workId === w.id && t.qa && !t.qa.ok).length,
    }));
}

export async function getWork(store, workId) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) return null;
  const chapters = sortChapters(work).map((c) => {
    const trs = Object.values(db.translations).filter((t) => t.chapterId === c.id);
    return {
      ...c,
      translations: trs.map((t) => t.target),
      versionCount: c.versions?.length || 1,
      warnings: trs.reduce((n, t) => n + (t.qa?.warns || 0) + (t.qa?.errors || 0), 0),
      qa: trs.map((t) => ({ lang: t.target, warnings: t.warnings || [], qa: t.qa })).filter((t) => t.warnings?.length),
    };
  });
  const terms = await store.loadTerms(workId);
  const volumes = (work.volumes || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((v) => ({ ...v, chapterCount: chapters.filter((c) => (c.volumeKey || "") === v.key).length }))
    .filter((v) => v.chapterCount > 0 || v.label);
  return {
    ...work, chapters, volumes, terms,
    translatedCount: chapters.reduce((n, c) => n + c.translations.length, 0),
    volumeCount: volumes.filter((v) => v.label).length,
  };
}

export async function getChapter(store, { workId, chapterId, lang = "" }) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) return null;
  const chapter = work.chapters.find((c) => c.id === chapterId || String(c.index) === String(chapterId));
  if (!chapter) return null;
  const original = await store.loadText(chapter.sourceHash).catch(() => "");
  const recs = Object.values(db.translations).filter((t) => t.chapterId === chapter.id);
  const available = recs.map((t) => t.target);
  let translation = null;
  let record = null;
  if (lang && lang !== work.lang) {
    const rec = db.translations[`${workId}|${chapter.id}|${lang}`];
    if (rec) {
      translation = await store.loadText(rec.hash).catch(() => null);
      record = { provider: rec.provider, at: rec.at, warnings: rec.warnings || [], qa: rec.qa };
    }
  }
  const chapters = sortChapters(work);
  const pos = chapters.findIndex((c) => c.id === chapter.id);
  return {
    work: { id: work.id, title: work.title, author: work.author, lang: work.lang, settings: work.settings, languages: work.languages, volumes: work.volumes || [] },
    chapter, original, translation, available, record,
    prev: pos > 0 ? { id: chapters[pos - 1].id, title: chapters[pos - 1].title, volume: chapters[pos - 1].volume } : null,
    next: pos < chapters.length - 1 ? { id: chapters[pos + 1].id, title: chapters[pos + 1].title, volume: chapters[pos + 1].volume } : null,
  };
}

export async function stats(store, { fetchFn } = {}) {
  const db = await store.load();
  const works = Object.values(db.works);
  const translations = Object.values(db.translations);
  const warns = translations.reduce((n, t) => n + (t.qa?.warns || 0) + (t.qa?.errors || 0), 0);
  return {
    works: works.length,
    volumes: works.reduce((n, w) => n + (w.volumes || []).filter((v) => v.label).length, 0),
    chapters: works.reduce((n, w) => n + w.chapters.length, 0),
    translations: translations.length,
    terms: works.reduce((n, w) => n + Object.values(w.terms || {}).reduce((a, b) => a + b, 0), 0),
    tmSegments: works.reduce((n, w) => n + Object.values(w.tmSegments || {}).reduce((a, b) => a + b, 0), 0),
    warnings: warns,
    calls: works.reduce((n, w) => n + (w.usage?.calls || 0), 0),
    languages: [...new Set([...works.map((w) => w.lang), ...translations.map((t) => t.target)])].filter(Boolean).sort(),
    storage: store.backendName,
  };
}

export async function activityFeed(store, { limit = 40 } = {}) {
  const db = await store.load();
  return (db.activity || []).slice(-limit).reverse();
}

/** Full-text-ish search across titles, terms and stored texts. */
export async function searchLibrary(store, { q, limit = 30 } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return { works: [], terms: [], texts: [] };
  const db = await store.load();
  const works = (await listWorks(store, { q })).slice(0, limit);

  const terms = [];
  for (const w of Object.values(db.works)) {
    const t = await store.loadTerms(w.id).catch(() => ({}));
    for (const term of Object.values(t)) {
      const forms = Object.values(term.langs || {}).flatMap((s) => [s.canonical, ...(s.variants || [])]);
      if (term.source.toLowerCase().includes(needle) || forms.some((f) => (f || "").toLowerCase().includes(needle))) {
        terms.push({ workId: w.id, title: w.title, source: term.source, langs: Object.fromEntries(Object.entries(term.langs || {}).map(([l, s]) => [l, s.canonical])) });
        if (terms.length >= limit) break;
      }
    }
    if (terms.length >= limit) break;
  }

  const texts = [];
  const recent = Object.values(db.translations).sort((a, b) => b.at - a.at).slice(0, 150);
  for (const tr of recent) {
    if (texts.length >= limit) break;
    const body = await store.loadText(tr.hash).catch(() => "");
    const idx = body.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      texts.push({ workId: tr.workId, chapterId: tr.chapterId, lang: tr.target, snippet: body.slice(Math.max(0, idx - 60), idx + 120).replace(/\n/g, " ") });
    }
  }
  return { works, terms, texts };
}

/* ------------------------------------------------------------ delete / edit */

export async function updateWork(store, workId, { title, author, sourceUrl, sourceLang, settings } = {}) {
  await store.load();
  const result = await store.update((db) => {
    const work = db.works[workId];
    if (!work) throw new Error("Unknown story: " + workId);
    if (title !== undefined) work.title = String(title).trim();
    if (author !== undefined) work.author = String(author).trim();
    if (sourceUrl !== undefined) work.sourceUrl = String(sourceUrl).trim();
    if (sourceLang !== undefined) work.lang = sourceLang;
    if (settings) work.settings = { ...DEFAULT_SETTINGS, ...work.settings, ...settings };
    // Re-point the identity index so future uploads with the new title/author/url
    // still land in THIS story instead of creating a duplicate.
    for (const [k, v] of Object.entries(db.workIndex)) if (v === workId) delete db.workIndex[k];
    db.workIndex[workKey(work.title, work.author, work.sourceUrl)] = workId;
    work.updatedAt = Date.now();
    logActivity(db, { type: "work-edited", workId, detail: work.title });
    return work;
  });
  await store.flush();
  return result;
}

export async function deleteChapter(store, { workId, chapterId }) {
  await store.load();
  const removed = await store.update((db) => {
    const work = db.works[workId];
    if (!work) throw new Error("Unknown story: " + workId);
    const i = work.chapters.findIndex((c) => c.id === chapterId);
    if (i < 0) throw new Error("Unknown chapter: " + chapterId);
    const [chapter] = work.chapters.splice(i, 1);
    for (const key of Object.keys(db.translations)) if (db.translations[key].chapterId === chapterId) delete db.translations[key];
    work.updatedAt = Date.now();
    logActivity(db, { type: "chapter-deleted", workId, chapterId, detail: chapter.title });
    return chapter;
  });
  await store.flush();
  return removed;
}

export async function deleteWork(store, { workId }) {
  await store.load();
  const removed = await store.update((db) => {
    const work = db.works[workId];
    if (!work) throw new Error("Unknown story: " + workId);
    delete db.works[workId];
    for (const [k, v] of Object.entries(db.workIndex)) if (v === workId) delete db.workIndex[k];
    for (const key of Object.keys(db.translations)) if (db.translations[key].workId === workId) delete db.translations[key];
    db.activity = (db.activity || []).filter((a) => a.workId !== workId);
    logActivity(db, { type: "work-deleted", workId, detail: work.title });
    return work;
  });
  store.saveTerms(workId, {});
  for (const lang of removed.languages || []) store.saveTm(workId, lang, {});
  await store.flush();
  return { id: removed.id, title: removed.title };
}

export async function restoreVersion(store, { workId, chapterId, hash }) {
  await store.load();
  const out = await store.update((db) => {
    const work = db.works[workId];
    if (!work) throw new Error("Unknown story: " + workId);
    const chapter = work.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw new Error("Unknown chapter: " + chapterId);
    if (!chapter.versions.some((v) => v.hash === hash)) throw new Error("Unknown version");
    chapter.sourceHash = hash;
    chapter.bodyHash = hash;
    chapter.updatedAt = Date.now();
    work.updatedAt = Date.now();
    // Content changed → drop this chapter's translations so they re-translate.
    for (const key of Object.keys(db.translations)) if (db.translations[key].chapterId === chapterId) delete db.translations[key];
    logActivity(db, { type: "version-restored", workId, chapterId, detail: chapter.title });
    return { chapter, versions: chapter.versions };
  });
  await store.flush();
  return out;
}

/* ------------------------------------------------------------ user corrections */

export async function correctTerm(store, { workId, lang, source, canonical, forms = [] } = {}) {
  if (!workId || !lang || !source) throw new Error("workId, lang and source are required.");
  await store.load();
  const terms = await store.loadTerms(workId);
  const before = terms[source];
  const olds = [...new Set([...(forms || []), ...termForms(before, lang)])].filter((o) => o && o !== canonical);

  const term = terms[source] || (terms[source] = { source, origin: "user", at: Date.now(), langs: {} });
  const slot = term.langs[lang] || (term.langs[lang] = { canonical: null, variants: [], origin: "user", at: Date.now() });
  slot.variants = [...new Set([...(slot.variants || []), ...olds])].filter((v) => v !== canonical);
  slot.canonical = canonical;
  slot.origin = "user";
  slot.at = Date.now();
  term.origin = "user";
  store.saveTerms(workId, terms);

  const replace = (text) => {
    let out = text;
    for (const o of olds) if (o && out.includes(o)) out = out.replaceAll(o, canonical);
    return out;
  };

  // 1. translation memory for this story+language
  const tm = await store.loadTm(workId, lang);
  let tmRewrites = 0;
  for (const [h, v] of Object.entries(tm)) {
    const next = replace(v.text);
    if (next !== v.text) { tm[h] = { ...v, text: next, at: Date.now() }; tmRewrites++; }
  }
  if (tmRewrites) store.saveTm(workId, lang, tm);

  // 2. every saved chapter translation in that language
  const db = await store.load();
  let chapterRewrites = 0;
  const rewrites = [];
  for (const [key, tr] of Object.entries(db.translations)) {
    if (tr.workId !== workId || tr.target !== lang) continue;
    const text = await store.loadText(tr.hash).catch(() => null);
    if (text == null) continue;
    const next = replace(text);
    if (next !== text) { rewrites.push([key, await store.saveText(next)]); chapterRewrites++; }
  }
  await store.update((d) => {
    for (const [key, hash] of rewrites) if (d.translations[key]) d.translations[key].hash = hash;
    const w = d.works[workId];
    if (w) { w.terms = termCounts(terms); w.updatedAt = Date.now(); }
    logActivity(d, { type: "term-corrected", workId, lang, detail: `${source} → ${canonical}` });
  });
  await store.flush();
  return {
    term: terms[source],
    tmRewrites,
    chapterRewrites,
    summary: `Updated "${canonical}" in ${chapterRewrites} saved translation(s) and ${tmRewrites} memory segment(s). No re-translation needed.`,
  };
}

/* ---------------------------------------------------------------- glossary I/O */

export async function suggestTerms(store, { workId, lang = "en", fetchFn = fetch } = {}) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const terms = await store.loadTerms(workId);
  const existing = Object.values(terms).filter((t) => t.langs?.[lang]);
  const known = new Set(Object.keys(terms));
  const text = await store.loadText(work.chapters[0]?.sourceHash || "").catch(() => "");
  const candidates = latinCandidates(text).concat([]).filter((c) => !known.has(c));
  let modelPairs = [];
  try {
    const key = process.env.GROQ_API_KEY || process.env.AI_API_KEY;
    if (key && text) {
      modelPairs = await extractTermsWithModel(text, {
        source: work.lang, target: lang, config: resolveProvider("groq", { model: PRIMARY.model, apiKey: key }), fetchFn,
      });
    }
  } catch { /* ignore */ }
  return {
    terms: existing.map((t) => ({ source: t.source, canonical: t.langs[lang].canonical, origin: t.langs[lang].origin, variants: t.langs[lang].variants })),
    candidates: candidates.map((c) => ({ source: c, suggested: c })),
    modelTerms: modelPairs.filter((p) => !known.has(p.source)),
  };
}

export { termsToCsv, parseCsv, parseGlossary };

/** Parse a glossary paste: JSON, "a=b" lines, or CSV with or without a header. */
export function parseTermInput(input) {
  const s = String(input || "").trim();
  if (!s) return [];
  if (s.startsWith("{") || s.startsWith("[")) return parseGlossary(s);
  const rows = parseCsv(s);
  const out = [];
  for (const [a, b] of rows) {
    if (!a || b === undefined) continue;
    const src = a.trim();
    const tgt = String(b).trim();
    if (/^(source|original|term)$/i.test(src)) continue; // header
    if (src && tgt) out.push({ source: src, target: tgt });
  }
  // Fall back to "a=b" / "a -> b" / "a:b" lines when there are no commas.
  return out.length ? out : parseGlossary(s);
}

export async function importGlossary(store, { workId, lang, data }) {
  const pairs = parseTermInput(data);
  if (!pairs.length) throw new Error("No terms found — use CSV (source,canonical), 'a=b' lines, or JSON.");
  const terms = await store.loadTerms(workId);
  const added = mergeTerms(terms, lang, pairs);
  // imported terms are treated as user decisions
  for (const p of pairs) if (terms[p.source]?.langs?.[lang]) { terms[p.source].langs[lang].canonical = p.target; terms[p.source].langs[lang].origin = "user"; terms[p.source].origin = "user"; }
  store.saveTerms(workId, terms);
  await store.update((d) => { const w = d.works[workId]; if (w) { w.terms = termCounts(terms); w.updatedAt = Date.now(); } logActivity(d, { type: "glossary-imported", workId, lang, detail: `${pairs.length} terms` }); });
  await store.flush();
  return { imported: pairs.length, added };
}

export async function exportGlossary(store, { workId, lang, format = "csv" }) {
  const terms = await store.loadTerms(workId);
  if (format === "json") return JSON.stringify(termsToCsv(terms, lang) ? Object.fromEntries(Object.values(terms).filter((t) => t.langs?.[lang]?.canonical).map((t) => [t.source, t.langs[lang].canonical])) : {}, null, 2);
  return termsToCsv(terms, lang);
}
