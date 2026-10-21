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
  termCounts, termsToCsv, parseCsv, parseGlossary, cleanNoisyTerms,
} from "./terms.js";
import { lintTranslation, dedupeWarnings, summarizeWarnings, cleanNovelArtifacts, cleanTranslationArtifacts, normalizeDifficulty, DEFAULT_DIFFICULTY, DIFFICULTIES } from "./qa.js";

// Chunk size is part of the translation-memory key: changing it invalidates the
// whole cache, so keep this stable.
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
const CHAPTER_MARKER = /^\s*(?:第\s*\d+\s*[章話话節节回]|(?:chapter|kapitel)\s*\d+|ch\.?\s*\d+|prolog(?:ue)?|slutkapitel)(?=$|[\s:：.。\-—]|[\p{Lu}])/iu;
// A volume marker must be a short standalone line — otherwise prose like
// "Volume 5 completely stagnated..." would be mistaken for a volume heading.
const VOLUME_MARKER = /^\s*(?:(?:volume|vol\.?|book)\s*\d+|第\s*\d+\s*[巻卷]|\d+\s*巻)\s*[:：.\-—]?\s*\S{0,25}\s*$/i;
const TABLE_OF_CONTENTS = /^\s*(?:contents|table of contents|innehåll|innehall|目次)\s*$/i;
const TOC_END_CUE = /keep up with|håll dig uppdaterad|download|ladda ner|subscribe|visit us|jnovels\.com/i;
const BACK_MATTER = /^\s*(?:appendix|appendices|afterword|acknowledg(?:e)?ments?|colophon|glossary|index|yen newsletter)\b/i;
const EXTRANEOUS_LINE = /copyright|all rights reserved|this book is a work of fiction|fictional work|immateriell(?:a)? egendom|förlaget ansvarar inte|library of congress|cataloging-in-publication|lccn|isbn|first (?:yen|edition)|först publicerad|första utgåvan|publicerad i japan|rights to .*translation|translation by|översättning av|cover art|cover illustration|omslagsillustration|illustration by|yen press|yen on|tuttle-mori|facebook\.com|twitter\.com|instagram\.com|tumblr\.com|https?:\/\/|\b(?:lcc|ddc)\s+[a-z0-9]/i;

function splitAttachedHeadings(text) {
  const lines = normalizeText(text).split("\n");
  const output = [];
  const tocEntry = /(?:Chapter|Kapitel)\s*\d+|Slutkapitel|第\s*\d+\s*[章話话節节回]/gu;
  for (const line of lines) {
    // In OCR'd TOCs multiple chapter entries are often glued into one line.
    const entries = [...line.matchAll(tocEntry)];
    if (entries.length > 1) {
      for (let i = 0; i < entries.length; i++) {
        const start = entries[i].index;
        const end = entries[i + 1]?.index ?? line.length;
        if (i === 0 && start > 0) output.push(line.slice(0, start).trim());
        output.push(line.slice(start, end).trim());
      }
    } else {
      output.push(line.replace(/^(Prolog(?:ue)?)(?=[\p{Lu}])/u, "$1\n"));
    }
  }
  return output.join("\n");
}

/** Remove publisher matter, contents listings, and back matter before splitting. */
function storyTextOnly(text) {
  let lines = splitAttachedHeadings(text).split("\n");
  const tocStart = lines.findIndex((line) => TABLE_OF_CONTENTS.test(line));
  if (tocStart >= 0) {
    const tocEnd = lines.findIndex((line, i) => i > tocStart && TOC_END_CUE.test(line));
    if (tocEnd >= 0) {
      // Contents pages often list chapter headings as if they were real chapters.
      // Resume at the first heading after the publisher's promo/footer.
      const storyAfterPromo = lines.findIndex((line, i) => i > tocEnd && CHAPTER_MARKER.test(line));
      lines = storyAfterPromo >= 0 ? lines.slice(storyAfterPromo) : [];
    } else {
      // Without a clear footer, do not guess which listed heading is the real story.
      return "";
    }
  }

  const firstStory = lines.findIndex((line) => CHAPTER_MARKER.test(line));
  if (firstStory >= 0) {
    // Keep a volume heading immediately before the first chapter marker.
    let start = firstStory;
    for (let i = firstStory - 1; i >= 0; i--) {
      if (VOLUME_MARKER.test(lines[i])) { start = i; break; }
      if (lines[i].trim()) break;
    }
    lines = lines.slice(start);
  } else if (tocStart >= 0) return "";

  const kept = [];
  for (const line of lines) {
    if (BACK_MATTER.test(line) || TOC_END_CUE.test(line)) break;
    if (!EXTRANEOUS_LINE.test(line)) kept.push(line);
  }
  return kept.join("\n").trim();
}

const PROLOGUE_MARKER = /^\s*prolog(?:ue)?(?=$|[\s:：.。\-—]|[\p{Lu}])/iu;

/** Locate an explicit prologue, preferring the one after a contents-page footer. */
function prologueStartIndex(text) {
  const lines = splitAttachedHeadings(text).split("\n");
  const prologues = lines.flatMap((line, index) => PROLOGUE_MARKER.test(line) ? [index] : []);
  if (!prologues.length) return -1;
  const contentsIndex = lines.findIndex((line) => TABLE_OF_CONTENTS.test(line));
  if (contentsIndex < 0) return prologues[0];
  const promoIndex = lines.findIndex((line, i) => i > contentsIndex && TOC_END_CUE.test(line));
  if (promoIndex >= 0) return prologues.find((index) => index > promoIndex) ?? -1;
  // Contents-only files have no actual story section to retain.
  return -1;
}

/** Return null unless an explicit prologue proves there is leading matter to remove. */
function removeBeforePrologue(text) {
  const original = String(text ?? "");
  const lines = splitAttachedHeadings(original).split("\n");
  const start = prologueStartIndex(original);
  if (start <= 0) return null;
  return lines.slice(start).join("\n").trim();
}

/** Remove publisher/TOC text and leading front-matter chapters from stored stories. */
export async function cleanExistingFrontMatter(store) {
  const db = await store.load();
  const plans = [];
  const removedChapters = new Map();
  const chapterTitles = new Map();
  for (const work of Object.values(db.works || {})) {
    const chapters = sortChapters(work);
    let firstPrologue = -1;
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const source = await store.loadText(chapter.sourceHash).catch(() => "");
      const prologueIndex = prologueStartIndex(source);
      if (PROLOGUE_MARKER.test(chapter.title || "") || prologueIndex >= 0) {
        firstPrologue = i;
        if (/^(?:front matter|chapter\s+\d+)$/i.test(chapter.title || "") && prologueIndex >= 0) {
          chapterTitles.set(`${work.id}|${chapter.id}`, splitAttachedHeadings(source).split("\n")[prologueIndex].trim());
        }
        break;
      }
    }
    if (firstPrologue > 0) removedChapters.set(work.id, new Set(chapters.slice(0, firstPrologue).map((chapter) => chapter.id)));

    for (const chapter of chapters) {
      const hashes = new Set([chapter.sourceHash, ...(chapter.versions || []).map((version) => version.hash)].filter(Boolean));
      const replacements = new Map();
      for (const hash of hashes) {
        const original = await store.loadText(hash).catch(() => null);
        if (original == null) continue;
        const cleaned = removeBeforePrologue(original);
        if (cleaned == null || cleaned === original) continue;
        replacements.set(hash, await store.saveText(cleaned));
      }
      if (replacements.size) plans.push({ workId: work.id, chapterId: chapter.id, replacements });
    }
  }
  if (!plans.length && !removedChapters.size && !chapterTitles.size) return 0;

  await store.update((current) => {
    for (const [workId, ids] of removedChapters) {
      const work = current.works[workId];
      if (!work) continue;
      work.chapters = work.chapters.filter((chapter) => !ids.has(chapter.id));
      for (const key of Object.keys(current.translations || {})) {
        if (ids.has(current.translations[key].chapterId)) delete current.translations[key];
      }
      work.updatedAt = Date.now();
    }
    for (const [key, title] of chapterTitles) {
      const [workId, chapterId] = key.split("|");
      const work = current.works[workId];
      const chapter = work?.chapters?.find((item) => item.id === chapterId);
      if (chapter && title) chapter.title = title;
    }
    for (const plan of plans) {
      const work = current.works[plan.workId];
      const chapter = work?.chapters?.find((item) => item.id === plan.chapterId);
      if (!chapter) continue;
      const activeReplacement = plan.replacements.get(chapter.sourceHash);
      chapter.sourceHash = activeReplacement || chapter.sourceHash;
      if (activeReplacement) chapter.bodyHash = activeReplacement;
      chapter.versions = (chapter.versions || []).map((version) => ({
        ...version, hash: plan.replacements.get(version.hash) || version.hash,
      }));
      if (activeReplacement) {
        for (const key of Object.keys(current.translations || {})) {
          if (current.translations[key].chapterId === chapter.id) delete current.translations[key];
        }
        chapter.updatedAt = Date.now();
        work.updatedAt = chapter.updatedAt;
      }
    }
  });
  await store.flush();
  const affected = new Set([
    ...plans.map(({ workId, chapterId }) => `${workId}|${chapterId}`),
    ...[...removedChapters].flatMap(([workId, ids]) => [...ids].map((chapterId) => `${workId}|${chapterId}`)),
    ...chapterTitles.keys(),
  ]);
  return affected.size;
}

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
  const norm = storyTextOnly(text);
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
    .map((p, i) => ({ volume: p.volume, title: chapterTitleFor(p, i), text: p.lines.join("\n").trim() }))
    .filter((c) => c.text);
  return chapters.length ? chapters : [{ volume: volumeLabel(defaultVolume), title: "", text: norm }];
}

/** Use the marker plus the chapter's own subtitle when the text has one. */
function chapterTitleFor(part, index) {
  const lines = part.lines.map((l) => l.trim()).filter(Boolean);
  const marker = (part.title || "").trim();
  const first = lines[0] || "";
  if (/^copyright$/i.test(first) && !marker) return "Front Matter";
  const looksLikeTitle = first.length <= 90 && first.split(/\s+/).length <= 12 && !/[.。]$/.test(first) && first !== marker;
  const subtitle = looksLikeTitle ? first : "";
  if (marker && subtitle) return `${marker} — ${subtitle.replace(/[!?]$/, "")}`;
  if (marker) return marker;
  if (subtitle) return subtitle;
  return `Chapter ${index + 1}`;
}

/* ------------------------------------------------------------------- terms */

const termExtractionLocks = new Map();

export async function ensureTermsForLang(store, workId, lang, { fetchFn = fetch, useModel = true, sampleText } = {}) {
  if (!lang) return 0;
  const db = await store.load();
  const work = db.works[workId];
  if (!work || work.termExtracted?.[lang]) return 0;
  const lockKey = `${workId}|${lang}`;
  if (termExtractionLocks.has(lockKey)) return termExtractionLocks.get(lockKey);
  const task = (async () => {
  // During translation the current chapter is already loaded; reuse it rather
  // than fetching several more source blobs from remote storage before the first
  // model request. Explicit term refresh still samples a few chapters.
  let sample;
  if (sampleText !== undefined) {
    sample = String(sampleText).slice(0, 14000);
  } else {
    const sampleChapters = sortChapters(work).slice(0, 3);
    sample = (await Promise.all(sampleChapters.map((c) => store.loadText(c.sourceHash).catch(() => ""))))
      .join("\n\n").slice(0, 14000);
  }
  const terms = await store.loadTerms(workId);
  // Latin originals are canonical in every language — cheap, always applied.
  let added = mergeTerms(terms, lang, latinCandidates(sample).slice(0, 200).map((c) => ({ source: c, translation: c })));
  const key = useModel && (process.env.GROQ_API_KEY || process.env.AI_API_KEY);
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
  } else {
    // No model key: translation can proceed with local Latin-name candidates;
    // avoid rescanning source text on every chapter in the same target language.
    store.saveTerms(workId, terms);
    await store.update((d) => {
      const w = d.works[workId];
      if (w) {
        w.termExtracted = { ...(w.termExtracted || {}), [lang]: true };
        w.terms = termCounts(terms);
      }
    });
  }
  return added;
  })();
  termExtractionLocks.set(lockKey, task);
  try { return await task; }
  finally { if (termExtractionLocks.get(lockKey) === task) termExtractionLocks.delete(lockKey); }
}

/** Force a fresh term discovery for one language (re-samples several chapters). */
export async function refreshTerms(store, { workId, lang, fetchFn = fetch }) {
  if (!workId || !lang) throw new Error("workId and lang are required.");
  await store.update((d) => {
    const w = d.works[workId];
    if (w) {
      const done = { ...(w.termExtracted || {}) };
      delete done[lang];
      w.termExtracted = done;
    }
  });
  await store.flush();
  const added = await ensureTermsForLang(store, workId, lang, { fetchFn });
  const terms = await store.loadTerms(workId);
  const mapped = Object.values(terms).filter((t) => t.langs?.[lang]?.canonical).length;
  return { added, mapped, total: Object.keys(terms).length };
}

/** Delete a single term (a typo/junk entry) from a story's glossary. */
export async function deleteTerm(store, { workId, source } = {}) {
  if (!workId || !source) throw new Error("workId and source are required.");
  const terms = await store.loadTerms(workId);
  const key = Object.keys(terms).find((k) => k === source) || Object.keys(terms).find((k) => k.toLowerCase() === String(source).toLowerCase());
  if (!key) throw new Error("Unknown term.");
  delete terms[key];
  store.saveTerms(workId, terms);
  await store.update((d) => {
    const w = d.works[workId];
    if (w) { w.terms = termCounts(terms); w.updatedAt = Date.now(); }
    logActivity(d, { type: "term-deleted", workId, detail: key });
  });
  await store.flush();
  return { deleted: key, remaining: Object.keys(terms).length };
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
    result.termsAdded = mergeTerms(terms, TERM_REF_LANG, latinCandidates(norm).slice(0, 200).map((c) => ({ source: c, translation: c })));
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
  workId, chapterId, target, difficulty = DEFAULT_DIFFICULTY, force = false, fetchFn = fetch,
  translate = translateWithPolicy, onProgress, providers,
} = {}) {
  if (!target) throw new Error("A target language is required.");
  const level = normalizeDifficulty(difficulty);
  const db0 = await store.load();
  const work = db0.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const chapter = work.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error("Unknown chapter: " + chapterId);
  const sameLanguage = target === work.lang; // allowed: rewrite/simplify in the same language

  const text = await store.loadText(chapter.sourceHash);
  // Keep translation's first request focused on translation. Reuse the already
  // loaded chapter for local term candidates; model-assisted extraction remains
  // available through the explicit Refresh terms action.
  await ensureTermsForLang(store, workId, target, { fetchFn, useModel: false, sampleText: text });
  const settings = { ...DEFAULT_SETTINGS, ...(work.settings || {}) };
  const terms = await store.loadTerms(workId);
  const allGlossary = termsGlossary(terms, target);
  // Only the terms that actually occur in a chunk go into its prompt, so a big
  // story's glossary never bloats (or confuses) the model.
  // Identity rows (source === target) only tell the model to keep English in
  // the output — skip them in the prompt so Swedish actually gets translated.
  // Real name-keeping still happens naturally; lint also ignores identity.
  const glossaryFor = (chunkText) => allGlossary.filter((g) => g.source.toLocaleLowerCase() !== g.target.toLocaleLowerCase() && chunkText.includes(g.source));
  const tm = await store.loadTm(workId, target, level);
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
  // Translate several chunks at once: the free provider pool spreads them across
  // different free tiers, which is what makes a whole chapter feasible for free.
  const CONC = Math.max(1, Math.min(Number(process.env.TRANSLATE_CONCURRENCY || 5), todo.length));
  let nextChunk = 0;
  let failure = null;
  let doneCount = 0;
  const usedProviders = new Set();

  await Promise.all(Array.from({ length: CONC }, async () => {
    while (!failure) {
      const k = nextChunk++;
      if (k >= todo.length) return;
      const i = todo[k];
      try {
        const r = await translate(chunks[i], {
          source: work.lang, target, glossary: glossaryFor(chunks[i]), prevTail: results[i - 1]?.slice(-500) || "",
          pinned, fetchFn, keepHonorifics: settings.keepHonorifics, formality: settings.formality, notes: settings.notes,
          difficulty: level, sameLanguage, providers,
        });
        // Strip leftover source artefacts (stray と, 「」 …) before storing/linting.
        results[i] = cleanTranslationArtifacts(r.text.trim(), target);
        provider = `${r.provider}/${r.model}`;
        pinned = { provider: r.provider, model: r.model };
        usedProviders.add(provider);
        tm[sha256(chunks[i])] = { text: results[i], at: Date.now(), difficulty: level };
        store.saveTm(workId, target, tm, level);
        await store.update((db) => {
          const w = db.works[workId];
          if (!w) return;
          w.models = { ...(w.models || {}), [target]: { provider: r.provider, model: r.model } };
          w.usage = w.usage || { calls: 0, chunks: 0, byModel: {} };
          w.usage.calls++;
          w.usage.chunks++;
          const mk = `${r.provider}/${r.model}`;
          w.usage.byModel[mk] = (w.usage.byModel[mk] || 0) + 1;
        });
        doneCount++;
        onProgress?.({ done: doneCount, total: todo.length });
      } catch (e) {
        failure = e;
        return;
      }
    }
  }));
  if (failure) {
    // Keep the chunks that did succeed — a retry resumes from exactly here.
    const partial = results.filter((v) => v !== undefined).join("\n\n");
    if (partial) {
      const h = await store.saveText(partial);
      await store.update((db) => {
        db.translations[`${workId}|${chapterId}|${target}|${level}`] = {
          key: `${workId}|${chapterId}|${target}|${level}`, workId, chapterId, target, difficulty: level,
          hash: h, chunks: chunks.length, done: doneCount, partial: true, at: Date.now(), provider, warnings, qa: summarizeWarnings(warnings),
        };
      });
      await store.flush();
    }
    throw new Error(`${failure.message} (saved ${doneCount}/${todo.length} chunks of this chapter — retry to continue)`);
  }

  const translation = results.filter((v) => v !== undefined).join("\n\n");
  // Whole-chapter lint on top of per-chunk warnings, then dedupe.
  warnings.push(...lintTranslation(text, translation, { target, glossary: allGlossary }));
  const uniqueWarnings = dedupeWarnings(warnings);
  const hash = await store.saveText(translation);
  const tkey = `${workId}|${chapterId}|${target}|${level}`;
  await store.update((db) => {
    const w = db.works[workId];
    db.translations[tkey] = {
      key: tkey, workId, chapterId, target, difficulty: level, hash, chunks: chunks.length, at: Date.now(),
      provider, warnings: uniqueWarnings, qa: summarizeWarnings(uniqueWarnings),
    };
    if (w) {
      w.languages = [...new Set([...w.languages, target])];
      w.updatedAt = Date.now();
      const tk = `${target}|${level}`;
      w.tmSegments = { ...(w.tmSegments || {}), [tk]: Object.keys(tm).length };
    }
    logActivity(db, { type: "translated", workId, chapterId, lang: target, detail: `${chapter.title} → ${target} (${level})` });
  });
  await store.flush();
  return { translation, chunks: chunks.length, cached: todo.length === 0, provider, difficulty: level, warnings: uniqueWarnings, qa: summarizeWarnings(uniqueWarnings) };
}

/** Translate chapters into one or more languages × reading levels (job-friendly). */
export async function translateWholeStory(store, { workId, target, difficulties = [DEFAULT_DIFFICULTY], force = false, fetchFn = fetch, translate = translateWithPolicy, onProgress } = {}) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const chapters = sortChapters(work);
  const levels = difficulties.map(normalizeDifficulty);
  const out = [];
  for (const level of levels) {
    for (const chapter of chapters) {
      try {
        const r = await translateChapter(store, { workId, chapterId: chapter.id, target, difficulty: level, force, fetchFn, translate });
        out.push({ chapterId: chapter.id, title: chapter.title, difficulty: level, ok: true, cached: r.cached, qa: r.qa });
      } catch (e) {
        out.push({ chapterId: chapter.id, title: chapter.title, difficulty: level, ok: false, error: e.message.slice(0, 200) });
      }
      onProgress?.({ done: out.length, total: chapters.length * levels.length, title: chapter.title, difficulty: level });
    }
  }
  return { target, difficulties: levels, chapters: out, ok: out.filter((c) => c.ok).length, failed: out.filter((c) => !c.ok).length };
}

/* ------------------------------------------------------------------- reads */

export async function listWorks(store, { q = "", limit = 200 } = {}) {
  const db = await store.load();
  const needle = q.trim().toLowerCase();
  const translations = Object.values(db.translations);
  return Object.values(db.works)
    .filter((w) => !needle || w.title.toLowerCase().includes(needle) || w.author.toLowerCase().includes(needle) || w.lang.includes(needle))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit)
    .map((w) => {
      const trs = translations.filter((t) => t.workId === w.id);
      // Summary only: a full work object can be hundreds of KB.
      return {
        id: w.id, title: w.title, author: w.author, lang: w.lang, sourceUrl: w.sourceUrl || "",
        coverUrl: w.coverKey ? `/api/works/${w.id}/cover?v=${encodeURIComponent(w.coverVersion || 0)}` : null,
        createdAt: w.createdAt, updatedAt: w.updatedAt,
        languages: w.languages || [], settings: w.settings || {},
        chapterCount: w.chapters.length,
        volumeCount: (w.volumes || []).filter((v) => v.label && w.chapters.some((c) => (c.volumeKey || "") === v.key)).length,
        translatedCount: trs.length,
        warnings: trs.filter((t) => t.qa && !t.qa.ok).length,
      };
    });
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
      variants: trs.map((t) => ({ lang: t.target, difficulty: t.difficulty || "medium" })),
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
    .filter((v) => v.chapterCount > 0);
  return {
    id: work.id, title: work.title, author: work.author, lang: work.lang, sourceUrl: work.sourceUrl || "",
    coverUrl: work.coverKey ? `/api/works/${work.id}/cover?v=${encodeURIComponent(work.coverVersion || 0)}` : null,
    createdAt: work.createdAt, updatedAt: work.updatedAt,
    languages: work.languages || [], settings: work.settings || {}, models: work.models || {},
    usage: work.usage || { calls: 0, chunks: 0, byModel: {} }, tmSegments: work.tmSegments || {},
    chapters, volumes,
    // NOTE: the term table is deliberately NOT embedded (it can be ~340 KB);
    // clients use GET /api/works/:id/terms?lang=xx instead.
    termCount: Object.keys(terms).length,
    translatedCount: chapters.reduce((n, c) => n + c.translations.length, 0),
    volumeCount: volumes.filter((v) => v.label).length,
  };
}

export async function getChapter(store, { workId, chapterId, lang = "", difficulty = DEFAULT_DIFFICULTY } = {}) {
  const level = normalizeDifficulty(difficulty);
  const db = await store.load();
  const work = db.works[workId];
  if (!work) return null;
  const chapter = work.chapters.find((c) => c.id === chapterId || String(c.index) === String(chapterId));
  if (!chapter) return null;
  const storedOriginal = await store.loadText(chapter.sourceHash).catch(() => "");
  const original = cleanNovelArtifacts(storedOriginal);
  const recs = Object.values(db.translations).filter((t) => t.chapterId === chapter.id);
  const glossary = lang ? termsGlossary(await store.loadTerms(workId), lang) : [];
  const getWarnings = (text, savedWarnings = []) => {
    if (text == null) return [];
    // Re-lint saved outputs on read so legacy false positives don't keep
    // resurfacing in the reader after the QA rules have been corrected.
    const current = lintTranslation(original, text, { target: lang, glossary });
    return dedupeWarnings(current.length ? current : savedWarnings.filter((warning) => warning.code === "empty"));
  };
  const available = recs.map((t) => ({ lang: t.target, difficulty: t.difficulty || "medium" }));
  let translation = null;
  let record = null;
  if (lang) {
    // exact level first, else the same language at another level (so the reader
    // still shows something instead of a blank page)
    const exact = db.translations[`${workId}|${chapter.id}|${lang}|${level}`];
    const fallback = exact || recs.find((t) => t.target === lang);
    if (fallback) {
      const storedTranslation = await store.loadText(fallback.hash).catch(() => null);
      translation = storedTranslation == null ? null : cleanTranslationArtifacts(storedTranslation, lang);
      const warnings = getWarnings(translation, fallback.warnings || []);
      record = {
        provider: fallback.provider, at: fallback.at, warnings,
        qa: summarizeWarnings(warnings), difficulty: fallback.difficulty || "medium", exact: !!exact,
      };
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
    volumes: works.reduce((n, w) => n + (w.volumes || []).filter((v) => v.label && w.chapters.some((c) => (c.volumeKey || "") === v.key)).length, 0),
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

export async function saveWorkCover(store, workId, buffer, contentType) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[contentType];
  if (!ext) throw new Error("Cover must be JPEG, PNG, WebP or GIF.");
  const coverKey = `covers/${workId}.${ext}`;
  const previousCoverKey = work.coverKey;
  await store.saveBuffer(coverKey, buffer, contentType);
  const coverVersion = Date.now();
  await store.update((d) => {
    const current = d.works[workId];
    if (!current) throw new Error("Unknown story: " + workId);
    current.coverKey = coverKey;
    current.coverType = contentType;
    current.coverVersion = coverVersion;
    current.updatedAt = coverVersion;
    logActivity(d, { type: "cover-updated", workId, detail: current.title });
  });
  await store.flush();
  if (previousCoverKey && previousCoverKey !== coverKey) await store.deleteFile(previousCoverKey);
  return { coverKey, coverType: contentType, coverVersion };
}

export async function getWorkCover(store, workId) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work?.coverKey) return null;
  const body = await store.loadBuffer(work.coverKey);
  return body ? { body, contentType: work.coverType || "application/octet-stream" } : null;
}

export async function deleteWorkCover(store, workId) {
  const db = await store.load();
  const work = db.works[workId];
  if (!work) throw new Error("Unknown story: " + workId);
  if (!work.coverKey) return { removed: false };
  const { coverKey } = work;
  await store.update((d) => {
    const current = d.works[workId];
    delete current.coverKey;
    delete current.coverType;
    delete current.coverVersion;
    current.updatedAt = Date.now();
    logActivity(d, { type: "cover-removed", workId, detail: current.title });
  });
  await store.flush();
  await store.deleteFile(coverKey);
  return { removed: true };
}

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
  for (const lang of removed.languages || []) for (const level of DIFFICULTIES) store.saveTm(workId, lang, {}, level);
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

  // 1. translation memory for this story+language — across EVERY reading level,
  //    so easy/medium/hard all keep the same names.
  let tmRewrites = 0;
  for (const level of DIFFICULTIES) {
    const tm = await store.loadTm(workId, lang, level);
    let changed = false;
    for (const [h, v] of Object.entries(tm)) {
      const next = replace(v.text);
      if (next !== v.text) { tm[h] = { ...v, text: next, at: Date.now() }; tmRewrites++; changed = true; }
    }
    if (changed) store.saveTm(workId, lang, tm, level);
  }

  // 2. every saved chapter translation in that language (all levels)
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

export { termsToCsv, parseCsv, parseGlossary, DIFFICULTIES, DEFAULT_DIFFICULTY, cleanTranslationArtifacts };

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

/** Maintenance: drop auto-discovered noise from a story's term table. */
export async function cleanTerms(store, { workId } = {}) {
  const terms = await store.loadTerms(workId);
  const before = Object.keys(terms).length;
  const removed = cleanNoisyTerms(terms);
  store.saveTerms(workId, terms);
  await store.update((d) => {
    const w = d.works[workId];
    if (w) { w.terms = termCounts(terms); w.updatedAt = Date.now(); }
    logActivity(d, { type: "terms-cleaned", workId, detail: `${removed.length} noisy term(s) removed` });
  });
  await store.flush();
  return { before, after: Object.keys(terms).length, removed: removed.length, sample: removed.slice(0, 15) };
}
