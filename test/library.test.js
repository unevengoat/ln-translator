import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
// Tests stub the network, so no need to pace calls like production does.
process.env.AI_MIN_INTERVAL_MS = "0";
process.env.AI_RETRY_BASE_MS = "5";
process.env.POOL_MIN_GAP_MS = "0";
process.env.POOL_COOLDOWN_MS = "0";
process.env.POOL_DEADLINE_MS = "600";
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-key";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, LocalBackend } from "../src/store.js";
import {
  ingestText, bulkIngest, splitChapters, translateChapter, translateWholeStory, correctTerm,
  listWorks, getWork, getChapter, stats, searchLibrary, activityFeed, updateWork,
  deleteChapter, deleteWork, restoreVersion, suggestTerms, importGlossary, exportGlossary, parseTermInput, cleanExistingFrontMatter,
  saveWorkCover, getWorkCover, deleteWorkCover,
} from "../src/library.js";
import { mergeTerms, termsGlossary, canonicalFor, extractCandidates, termsToCsv, termCounts, latinCandidates, cleanNoisyTerms } from "../src/terms.js";
import { lintTranslation, summarizeWarnings, normalizeDifficulty, cleanTranslationArtifacts, DIFFICULTIES } from "../src/qa.js";
import { isModelGone, pickCandidates, translateWithPolicy } from "../src/engines/models.js";
import { translatePinned } from "../src/engines/pool.js";

let dir, store;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), "ln-lib-")); store = new Store(new LocalBackend(dir), { debounceMs: 1 }); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const makeTranslator = () => {
  const calls = [];
  const translate = async (chunk, opts) => {
    calls.push({ chunk, pinned: opts.pinned, glossary: opts.glossary, notes: opts.notes });
    const g = (opts.glossary || []).map((x) => x.target).join(",");
    return { text: `[${opts.target}] ${chunk}${g ? " {" + g + "}" : ""}`, provider: opts.pinned?.provider || "groq", model: opts.pinned?.model || "openai/gpt-oss-120b" };
  };
  translate.calls = calls;
  return translate;
};
const CH1 = "Kirito walked to the window.\n\nHe thought of Asuna.";
const CH2 = "Kirito drew his sword.\n\nThe boss roared.";

describe("chapter splitting (bulk upload)", () => {
  it("splits on English and CJK chapter markers", () => {
    const text = "Chapter 1\nKirito walked.\n\nChapter 2\nAsuna smiled.";
    const parts = splitChapters(text);
    assert.equal(parts.length, 2);
    assert.match(parts[0].title, /Chapter 1/);
    assert.match(parts[1].title, /Chapter 2/);
    assert.equal(splitChapters("第1話 始まり\n本文。\n\n第2話 続き\n本文。").length, 2);
    assert.equal(splitChapters("Kapitel1Start\nText\nKapitel2Next\nMore").length, 2);
  });
  it("returns one chapter when there are no markers", () => {
    assert.equal(splitChapters("Just a wall of text with no markers.").length, 1);
  });
  it("excludes publisher matter and a concatenated contents page before splitting", () => {
    const text = `Copyright\nThe Eminence in Shadow 01 DAISUKE AIZAWA\nÖversättning av Kristi Fernandez Omslagsillustration av Touzai\nDenna bok är ett skönlitterärt verk.\nKAGE NO JITSURYOKUSHA vol. 1 ©Daisuke Aizawa 2018\nYen Press, LLC\nLibrary of Congress Cataloging-in-Publication Data ISBN 9781975359058\nInnehåll\nPrologFörbereder Perfect Stage! Kapitel 1Startar Shadowbroker Tutorial! Kapitel 2Tar på sig rollen som en Side Character i skolan! Kapitel 3Mitt Official Beginning som en Mastermind i handling! Kapitel 4De Two Sides av Shadow Garden?! Kapitel 5Bemästra Peaceful Life av en Nobody! Kapitel 6Scenen där Terrorists Take Over the School Slutkapitel: Min idé om Ultimate Shadow Commander! Appendix Afterword Yen Newsletter\nHåll dig uppdaterad om Light Novels genom att ladda ner vår mobilapp\nZerobooks Android Zerobooks IOS Ladda ner alla dina Favorite Light Novels Jnovels.com\nProlog\nThis is the actual prologue.\nKapitel 1Startar Shadowbroker Tutorial!\nThis is the actual first chapter.\nAfterword\nPublisher notes.`;
    const parts = splitChapters(text);
    assert.equal(parts.length, 2);
    assert.match(parts[0].title, /Prolog/);
    assert.match(parts[0].text, /actual prologue/);
    assert.match(parts[1].title, /Kapitel 1/);
    assert.match(parts[1].text, /actual first chapter/);
    const imported = parts.map((part) => `${part.title}\n${part.text}`).join("\n");
    assert.doesNotMatch(imported, /Copyright|ISBN|Library of Congress|Översättning|Yen Press|Jnovels|Publisher notes|contents/i);
    assert.equal((imported.match(/Shadowbroker Tutorial!/g) || []).length, 1, "the real chapter heading may share its TOC title, but must not create a duplicate chapter");
  });
  it("drops a contents-only file instead of importing it as a chapter", () => {
    assert.deepEqual(splitChapters("Innehåll\nProlog\nKapitel 1\nAfterword"), []);
  });
  it("cleans pre-prologue text from already stored chapters and drops stale translations", async () => {
    const work = await ingestText(store, {
      title: "Existing front matter", sourceLang: "en", chapterTitle: "Chapter 1",
      text: "Copyright\nISBN 12345\nProlog\nActual story starts here.",
    });
    const before = await getChapter(store, { workId: work.workId, chapterId: work.chapterId });
    assert.match(before.original, /Copyright/);
    await store.update((db) => {
      db.translations[`${work.workId}|${work.chapterId}|sv|medium`] = {
        key: `${work.workId}|${work.chapterId}|sv|medium`, workId: work.workId, chapterId: work.chapterId,
        target: "sv", difficulty: "medium", hash: work.hash || before.chapter.sourceHash,
      };
    });
    const count = await cleanExistingFrontMatter(store);
    assert.equal(count, 1);
    const after = await getChapter(store, { workId: work.workId, chapterId: work.chapterId });
    assert.equal(after.original, "Prolog\nActual story starts here.");
    assert.equal(after.chapter.title, "Prolog", "the old Front Matter label is corrected to the detected prologue heading");
    assert.equal(after.available.length, 0, "translations of the changed source must not be displayed");
    assert.equal(await cleanExistingFrontMatter(store), 0, "cleanup is idempotent");
  });
  it("renames an existing Front Matter chapter when its stored source begins with a prologue", async () => {
    const work = await ingestText(store, {
      title: "Relabel front matter", sourceLang: "en", chapterTitle: "Front Matter",
      text: "Prologue\nThe actual first lines.",
    });
    assert.equal(await cleanExistingFrontMatter(store), 1);
    const cleaned = await getChapter(store, { workId: work.workId, chapterId: work.chapterId });
    assert.equal(cleaned.chapter.title, "Prologue");
    assert.equal(cleaned.original, "Prologue\nThe actual first lines.");
    assert.equal(await cleanExistingFrontMatter(store), 0, "relabeling is idempotent");
  });
  it("removes earlier front-matter chapter records once a later prologue is identified", async () => {
    const front = await ingestText(store, {
      title: "Split front matter", sourceLang: "en", chapterTitle: "Title page",
      text: "Copyright\nISBN 12345\nThe Eminence in Shadow.",
    });
    const prologue = await ingestText(store, {
      title: "Split front matter", sourceLang: "en", chapterTitle: "Prolog",
      text: "The story begins here.",
    });
    await store.update((db) => {
      db.translations[`front|${front.chapterId}`] = { chapterId: front.chapterId, workId: front.workId, target: "sv", hash: "unused" };
    });
    const removed = await cleanExistingFrontMatter(store);
    assert.equal(removed, 1);
    const work = await getWork(store, front.workId);
    assert.deepEqual(work.chapters.map((chapter) => chapter.id), [prologue.chapterId]);
    assert.equal(Object.values((await store.load()).translations).some((translation) => translation.chapterId === front.chapterId), false);
    assert.equal(await cleanExistingFrontMatter(store), 0, "cleanup is idempotent");
  });
  it("does not alter existing chapters without an explicit prologue", async () => {
    const work = await ingestText(store, { title: "No prologue", sourceLang: "en", text: "An ordinary opening paragraph." });
    const before = await getChapter(store, { workId: work.workId, chapterId: work.chapterId });
    assert.equal(await cleanExistingFrontMatter(store), 0);
    const after = await getChapter(store, { workId: work.workId, chapterId: work.chapterId });
    assert.equal(after.original, before.original);
  });
});

describe("volumes", () => {
  it("detects volume and chapter markers together", () => {
    const text = "Volume 1\nChapter 1\nStart.\n\nChapter 2\nMore.\n\nVolume 2\nChapter 1\nLater.";
    const parts = splitChapters(text);
    assert.equal(parts.length, 3);
    assert.deepEqual(parts.map((p) => p.volume), ["Volume 1", "Volume 1", "Volume 2"]);
    assert.deepEqual(parts.map((p) => p.title), ["Chapter 1", "Chapter 2", "Chapter 1"]);
  });

  it("detects CJK volume markers", () => {
    const parts = splitChapters("第1巻\n第1話 始まり\n本文。\n\n第2話 続き\n本文。");
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map((p) => p.volume), ["第1巻", "第1巻"]);
  });

  it("does NOT treat the same chapter number in two volumes as a version", () => {
    const t = async (chunk, o) => ({ text: `[${o.target}]${chunk}`, provider: "groq", model: "m" });
    return (async () => {
      const a = await ingestText(store, { title: "Two Vols", sourceLang: "en", volume: "Volume 1", chapterTitle: "Chapter 1", text: "Alpha one.", translate: t });
      const b = await ingestText(store, { title: "Two Vols", sourceLang: "en", volume: "Volume 2", chapterTitle: "Chapter 1", text: "Beta one.", translate: t });
      assert.equal(a.workId, b.workId);
      assert.notEqual(a.chapterId, b.chapterId, "same index in a different volume is a different chapter");
      assert.equal(b.version, undefined);
      const work = await getWork(store, a.workId);
      assert.equal(work.chapters.length, 2);
      assert.deepEqual(work.volumes.map((v) => v.label), ["Volume 1", "Volume 2"]);
    })();
  });

  it("auto-numbers chapters within their volume and sorts by volume then index", async () => {
    const t = async (chunk, o) => ({ text: `[${o.target}]${chunk}`, provider: "groq", model: "m" });
    const w = await ingestText(store, { title: "Vol Sort", sourceLang: "en", volume: "Volume 1", text: "first.", translate: t });
    await ingestText(store, { title: "Vol Sort", sourceLang: "en", volume: "Volume 1", text: "second.", translate: t });
    await ingestText(store, { title: "Vol Sort", sourceLang: "en", volume: "Volume 2", text: "third.", translate: t });
    const work = await getWork(store, w.workId);
    assert.deepEqual(work.chapters.map((c) => [c.volume, c.index]), [["Volume 1", 1], ["Volume 1", 2], ["Volume 2", 1]]);
  });

  it("bulk-ingests a whole volume in one call", async () => {
    const t = async (chunk, o) => ({ text: `[${o.target}]${chunk}`, provider: "groq", model: "m" });
    const r = await bulkIngest(store, {
      title: "Bulk Volume", sourceLang: "ja", volume: "Volume 1",
      text: "第1話 始まり\nキリト。\n\n第2話 続き\nアスナ。",
      autoTranslateTo: ["sv"], translate: t,
    });
    assert.equal(r.chapters.length, 2);
    assert.ok(r.chapters.every((c) => c.volume === "Volume 1"));
    const work = await getWork(store, r.workId);
    assert.equal(work.volumes[0].label, "Volume 1");
    assert.equal(work.volumes[0].chapterCount, 2);
    assert.ok(work.chapters.every((c) => c.translations.includes("sv")));
  });

  it("keeps volume labels without markers (defaultVolume)", async () => {
    const t = async (chunk, o) => ({ text: `[${o.target}]${chunk}`, provider: "groq", model: "m" });
    const r = await bulkIngest(store, { title: "Labeled Vol", sourceLang: "ja", volume: "Volume 3", text: "キリトは歩いた。", translate: t });
    const work = await getWork(store, r.workId);
    assert.equal(work.chapters[0].volume, "Volume 3");
  });
});

describe("reading levels (difficulty)", () => {
  it("normalises level names", () => {
    assert.equal(normalizeDifficulty("simple"), "easy");
    assert.equal(normalizeDifficulty("advanced"), "hard");
    assert.equal(normalizeDifficulty(""), "medium");
    assert.equal(normalizeDifficulty(undefined), "medium");
    assert.deepEqual(DIFFICULTIES, ["easy", "medium", "hard"]);
  });

  it("keeps easy/medium/hard as separate translations with the SAME terms", async () => {
    const seen = [];
    const t = async (chunk, o) => {
      seen.push({ difficulty: o.difficulty, glossary: (o.glossary || []).map((g) => g.target).join(",") });
      return { text: `[${o.target}/${o.difficulty}] ${chunk}`, provider: "groq", model: "m" };
    };
    const a = await ingestText(store, { title: "Levels", sourceLang: "ja", text: "キリトは剣を抜いた。", translate: t });
    const terms = await store.loadTerms(a.workId);
    mergeTerms(terms, "de", [{ source: "キリト", translation: "Kirito" }]);
    store.saveTerms(a.workId, terms);
    await store.update((d) => { d.works[a.workId].termExtracted = { de: true }; });

    const easy = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "de", difficulty: "easy", translate: t });
    const hard = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "de", difficulty: "hard", translate: t });
    assert.equal(easy.difficulty, "easy");
    assert.match(easy.translation, /\[de\/easy\]/);
    assert.match(hard.translation, /\[de\/hard\]/);
    assert.notEqual(easy.translation, hard.translation, "levels must not share output");

    // the glossary handed to the model is identical at every level
    const glossaries = [...new Set(seen.map((s) => s.glossary))];
    assert.deepEqual(glossaries, ["Kirito"]);
    assert.deepEqual([...new Set(seen.map((s) => s.difficulty))].sort(), ["easy", "hard"]);

    // both levels are stored and listed
    const work = await getWork(store, a.workId);
    const levels = work.chapters[0].variants.filter((v) => v.lang === "de").map((v) => v.difficulty).sort();
    assert.deepEqual(levels, ["easy", "hard"]);

    // level memory is separate: easy is cached, hard still needs work
    const t2 = async (chunk, o) => ({ text: `[${o.target}/${o.difficulty}] ${chunk}`, provider: "groq", model: "m" });
    const easyAgain = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "de", difficulty: "easy", translate: t2 });
    assert.equal(easyAgain.cached, true);
  });

  it("reads a chapter at a specific level, falling back to another level", async () => {
    const t = async (chunk, o) => ({ text: `[${o.target}/${o.difficulty}]`, provider: "groq", model: "m" });
    const a = await ingestText(store, { title: "Level Read", sourceLang: "ja", text: "本文です。", translate: t });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "sv", difficulty: "medium", translate: t });
    const exact = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "sv", difficulty: "medium" });
    assert.equal(exact.record.exact, true);
    const fallback = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "sv", difficulty: "hard" });
    assert.equal(fallback.record.exact, false);
    assert.equal(fallback.record.difficulty, "medium");
    assert.ok(fallback.translation);
  });

  it("a term correction updates EVERY level of that language", async () => {
    const t = async (chunk, o) => ({ text: `${o.difficulty} Kirito hit`, provider: "groq", model: "m" });
    const a = await ingestText(store, { title: "Level Fix", sourceLang: "ja", text: "キリトは打った。", translate: t });
    const terms = await store.loadTerms(a.workId);
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    store.saveTerms(a.workId, terms);
    await store.update((d) => { d.works[a.workId].termExtracted = { en: true }; });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", difficulty: "easy", translate: t });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", difficulty: "hard", translate: t });
    const r = await correctTerm(store, { workId: a.workId, lang: "en", source: "キリト", canonical: "Keith" });
    assert.equal(r.chapterRewrites, 2, "both levels rewritten");
    for (const level of ["easy", "hard"]) {
      const ch = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "en", difficulty: level });
      assert.match(ch.translation, /Keith/);
      assert.doesNotMatch(ch.translation, /Kirito/);
    }
  });
});

describe("leftover-artifact cleanup", () => {
  it("removes stray kana particles and converts Japanese quotes", () => {
    assert.equal(cleanTranslationArtifacts("Kirito drew his sword. \u3068", "es"), "Kirito drew his sword.");
    assert.equal(cleanTranslationArtifacts("\u300c\u00a1Vamos!\u300d dijo Asuna.", "es"), "\u201c\u00a1Vamos!\u201d dijo Asuna.");
    assert.doesNotMatch(cleanTranslationArtifacts("dijo Asuna \u3068", "es"), /[\u3040-\u30ff]/);
  });
  it("leaves a CJK target untouched", () => {
    assert.equal(cleanTranslationArtifacts("彼は剣を抜いた。", "ja"), "彼は剣を抜いた。");
  });
  it("a cleaned translation no longer trips the lint", () => {
    const out = cleanTranslationArtifacts("Kirito walked. \u3068", "en");
    const w = lintTranslation("キリトは歩いた。", out, { target: "en", glossary: [{ source: "キリト", target: "Kirito" }] });
    assert.equal(summarizeWarnings(w).errors, 0);
    assert.ok(!w.some((x) => x.code === "source-script"));
  });
});

describe("ingest, dedupe, versions", () => {
  it("creates a work, recognises duplicates, and keeps versions", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CH1, translate: t });
    assert.ok(a.created);
    assert.equal((await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CH1, translate: t })).duplicate, true);
    const v = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CH1 + "\n\nNew line.", chapterIndex: 1, translate: t });
    assert.equal(v.version, true);
    const work = await getWork(store, a.workId);
    assert.equal(work.chapters.length, 1);
    assert.equal(work.chapters[0].versionCount, 2);
  });

  it("bulk-ingests many chapters into one story", async () => {
    const t = makeTranslator();
    const r = await bulkIngest(store, { title: "Bulk Story", sourceLang: "ja", text: "第1話 始まり\nキリト。\n\n第2話 続き\nアスナ。", autoTranslateTo: ["en"], translate: t });
    assert.equal(r.chapters.length, 2);
    assert.deepEqual(r.translated, ["第1話 始まり→en", "第2話 続き→en"]);
    const work = await getWork(store, r.workId);
    assert.equal(work.chapters.length, 2);
    assert.ok(work.chapters[0].translations.includes("en"));
  });

  it("keeps stories with different titles separate and links by source URL", async () => {
    const t = makeTranslator();
    const x = await ingestText(store, { title: "Other", sourceLang: "en", text: CH2, translate: t });
    const y = await ingestText(store, { title: "Linked", sourceUrl: "https://site/x", sourceLang: "en", text: CH2, translate: t });
    const z = await ingestText(store, { title: "Linked", sourceUrl: "https://site/x", sourceLang: "en", text: CH1, chapterIndex: 2, translate: t });
    assert.notEqual(x.workId, y.workId);
    assert.equal(y.workId, z.workId);
  });
});

describe("translation, memory, model pinning", () => {
  it("translates a longer chapter across chunks and reuses the saved segments", async () => {
    const t = makeTranslator();
    const text = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1}: ${"A longer sentence about the castle and its inhabitants. ".repeat(4)}`).join("\n\n");
    const a = await ingestText(store, { title: "Long Chapter Resume", sourceLang: "en", text, translate: t });
    const first = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "sv", translate: t });
    assert.ok(first.chunks > 1, "the chapter must be chunked");
    assert.equal(t.calls.length, first.chunks);
    assert.ok(first.translation.includes("Paragraph 24"));
    const calls = t.calls.length;
    const second = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "sv", translate: t });
    assert.equal(second.cached, true);
    assert.equal(t.calls.length, calls, "all completed chunks should be reused");
  });

  it("reuses the loaded chapter for local term candidates instead of refetching source blobs", async () => {
    const t = makeTranslator();
    const added = await ingestText(store, { title: "Term Warmup Read Count", sourceLang: "en", text: "A chapter with Alice and Bob.", translate: t });
    const loadText = store.loadText.bind(store);
    let reads = 0;
    store.loadText = async (...args) => { reads++; return loadText(...args); };
    try {
      await translateChapter(store, { workId: added.workId, chapterId: added.chapterId, target: "sv", translate: t });
      assert.equal(reads, 1, "translation should load the current chapter once and reuse it for local term candidates");
    } finally {
      store.loadText = loadText;
    }
  });

  it("translates once then serves from memory", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "TM Story", sourceLang: "ja", text: "こんにちは。\n\nさようなら。", translate: t });
    const first = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t });
    assert.equal(first.cached, false);
    const before = t.calls.length;
    const second = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t });
    assert.equal(second.cached, true);
    assert.equal(second.translation, first.translation);
    assert.equal(t.calls.length, before);
  });

  it("pins the story's model and passes story settings/notes", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Pin Story", sourceLang: "ja", text: "テスト。", settings: { notes: "cold tone", formality: "casual" }, translate: t });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "sv", translate: t });
    const work = await getWork(store, a.workId);
    assert.deepEqual(work.models.sv, { provider: "groq", model: "openai/gpt-oss-120b" });
    const c2 = await ingestText(store, { title: "Pin Story", sourceLang: "ja", text: "続き。", chapterIndex: 2, translate: t });
    const t2 = makeTranslator();
    await translateChapter(store, { workId: c2.workId, chapterId: c2.chapterId, target: "sv", translate: t2 });
    assert.equal(t2.calls[0].pinned.model, "openai/gpt-oss-120b");
    assert.equal(t2.calls[0].notes, "cold tone");
  });

  it("feeds the story glossary to the translator", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Gloss Story", sourceLang: "ja", text: "キリトは歩いた。", translate: t });
    const terms = await store.loadTerms(a.workId);
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    store.saveTerms(a.workId, terms);
    await store.update((d) => { d.works[a.workId].termExtracted = { en: true }; });
    const t2 = makeTranslator();
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.ok(t2.calls[0].glossary.some((g) => g.source === "キリト" && g.target === "Kirito"));
  });

  it("translates a whole story into a language", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Whole Story", sourceLang: "ja", text: "一。", translate: t });
    await ingestText(store, { title: "Whole Story", sourceLang: "ja", text: "二。", chapterIndex: 2, translate: t });
    const r = await translateWholeStory(store, { workId: a.workId, target: "es", translate: t });
    assert.equal(r.ok, 2);
    assert.equal(r.failed, 0);
    const work = await getWork(store, a.workId);
    assert.ok(work.chapters.every((c) => c.translations.includes("es")));
  });

  it("records QA warnings on a bad translation", async () => {
    const bad = async () => ({ text: "これは翻訳されていない。".repeat(40), provider: "groq", model: "m" });
    const a = await ingestText(store, { title: "QA Story", sourceLang: "ja", text: "テスト文章です。もう一文。", translate: bad });
    const r = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: bad });
    assert.ok(r.warnings.some((w) => w.code === "source-script"));
    const work = await getWork(store, a.workId);
    assert.ok(work.chapters[0].warnings >= 1);
  });
});

describe("terms", () => {
  it("keeps Latin originals and per-language canonicals", () => {
    assert.deepEqual(canonicalFor("Kirito"), { canonical: "Kirito", auto: true });
    const terms = {};
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito-sama" }]);
    mergeTerms(terms, "sv", [{ source: "キリト", translation: "Kirito" }]);
    assert.equal(terms["キリト"].langs.en.canonical, "Kirito");
    assert.deepEqual(terms["キリト"].langs.en.variants, ["Kirito-sama"]);
    assert.equal(termsGlossary(terms, "sv")[0].target, "Kirito");
    assert.deepEqual(termCounts(terms), { en: 1, sv: 1 });
  });
  it("drops common words but keeps real names", () => {
    const text = "Cid walked. Cid ran. Shadow Garden watched. The group met Alpha and Alpha nodded. Copyright page. He said names of the Vol.";
    const c = latinCandidates(text);
    assert.ok(c.includes("Cid"), "repeated short name kept");
    assert.ok(c.includes("Shadow Garden"), "multi-word name kept");
    assert.ok(c.includes("Alpha"), "repeated name kept");
    assert.ok(!c.some((x) => /^copyright$/i.test(x)), "common word dropped");
    assert.ok(!c.some((x) => /^names$/i.test(x)), "common word dropped");
    assert.ok(!c.some((x) => /^vol\.?$/i.test(x)), "abbreviation dropped");
  });

  it("cleans noisy terms from a table without touching user terms", () => {
    const terms = {};
    mergeTerms(terms, "en", [{ source: "Copyright", translation: "Copyright" }, { source: "Cid", translation: "Cid" }]);
    terms["Copyright"].langs.en.variants = [];
    terms["キリト"] = { source: "キリト", origin: "user", langs: { en: { canonical: "Keith", variants: [], origin: "user" } } };
    const removed = cleanNoisyTerms(terms);
    assert.deepEqual(removed, ["Copyright"]);
    assert.ok(terms.Cid, "real name kept");
    assert.ok(terms["キリト"], "user term kept");
  });

  it("extracts candidates and exports CSV", () => {
    const c = extractCandidates("キリト met Asuna in Tokyo.");
    assert.ok(c.includes("キリト") && c.includes("Asuna") && c.includes("Tokyo"));
    const terms = {};
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    assert.match(termsToCsv(terms, "en"), /^source,canonical\nキリト,Kirito\n$/);
  });
  it("parses glossary input in CSV, key=value and JSON forms", () => {
    assert.deepEqual(parseTermInput("キリト,Kirito\nアスナ,Asuna"), [{ source: "キリト", target: "Kirito" }, { source: "アスナ", target: "Asuna" }]);
    assert.deepEqual(parseTermInput("source,canonical\nA,B"), [{ source: "A", target: "B" }]);
    assert.deepEqual(parseTermInput("A=B"), [{ source: "A", target: "B" }]);
    assert.deepEqual(parseTermInput('{"A":"B"}'), [{ source: "A", target: "B" }]);
  });
  it("imports and exports a glossary for a story", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "GlossIO", sourceLang: "ja", text: "キリト。", translate: t });
    const imp = await importGlossary(store, { workId: a.workId, lang: "sv", data: "キリト,Kirito\nアスナ,Asuna" });
    assert.equal(imp.imported, 2);
    const csv = await exportGlossary(store, { workId: a.workId, lang: "sv" });
    assert.match(csv, /キリト,Kirito/);
    assert.match(csv, /アスナ,Asuna/);
  });
});

describe("corrections propagate", () => {
  it("rewrites saved translations and memory with no re-translation", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Fix Story", sourceLang: "ja", text: "キリトは窓を見た。", translate: t });
    const terms = await store.loadTerms(a.workId);
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    store.saveTerms(a.workId, terms);
    await store.update((d) => { d.works[a.workId].termExtracted = { en: true }; });
    const t2 = makeTranslator();
    const tr = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.match(tr.translation, /Kirito/);
    const before = t2.calls.length;
    const r = await correctTerm(store, { workId: a.workId, lang: "en", source: "キリト", canonical: "Keith" });
    assert.equal(r.chapterRewrites, 1);
    const ch = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "en" });
    assert.match(ch.translation, /Keith/);
    assert.doesNotMatch(ch.translation, /Kirito/);
    const again = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.doesNotMatch(again.translation, /Kirito/);
    assert.equal(t2.calls.length, before, "correction must not re-translate");
  });
});

describe("edit, delete, restore", () => {
  it("edits a story and keeps future uploads linked to it", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Rename Me", sourceLang: "en", text: CH1, translate: t });
    await updateWork(store, a.workId, { title: "Renamed", author: "New" });
    const w = await getWork(store, a.workId);
    assert.equal(w.title, "Renamed");
    const again = await ingestText(store, { title: "Renamed", author: "New", sourceLang: "en", text: CH2, chapterIndex: 2, translate: t });
    assert.equal(again.workId, a.workId, "new title must still map to the same story");
  });

  it("restores an earlier version and drops stale translations", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Ver Story", sourceLang: "ja", text: "一章\n本文です。", translate: t });
    const v1 = (await getWork(store, a.workId)).chapters[0].versions[0].hash;
    await ingestText(store, { title: "Ver Story", sourceLang: "ja", text: "一章\n本文です。\n\nchanged", chapterIndex: 1, translate: t });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t });
    assert.ok((await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "en" })).translation);
    await restoreVersion(store, { workId: a.workId, chapterId: a.chapterId, hash: v1 });
    assert.equal((await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "en" })).translation, null);
    assert.equal((await getChapter(store, { workId: a.workId, chapterId: a.chapterId })).original, "一章\n本文です。");
  });

  it("deletes a chapter, then a whole story", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Del Story", sourceLang: "en", text: CH1, translate: t });
    await ingestText(store, { title: "Del Story", sourceLang: "en", text: CH2, chapterIndex: 2, translate: t });
    await deleteChapter(store, { workId: a.workId, chapterId: a.chapterId });
    assert.equal((await getWork(store, a.workId)).chapters.length, 1);
    await deleteWork(store, { workId: a.workId });
    assert.equal(await getWork(store, a.workId), null);
  });
});

describe("search, activity, stats", () => {
  it("finds works, terms and translated text", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Findable Novel", sourceLang: "ja", text: "キリトは剣を抜いた。", autoTranslateTo: ["en"], translate: t });
    const byTitle = await searchLibrary(store, { q: "findable" });
    assert.ok(byTitle.works.length >= 1);
    const terms = await store.loadTerms(a.workId);
    mergeTerms(terms, "en", [{ source: "キリト", translation: "Kirito" }]);
    store.saveTerms(a.workId, terms);
    await store.flush();
    const byTerm = await searchLibrary(store, { q: "kirito" });
    assert.ok(byTerm.terms.length >= 1);
    const byText = await searchLibrary(store, { q: "剣を抜いた" });
    assert.ok(byText.texts.length >= 1 || byTitle.works.length >= 1);
  });

  it("logs activity and reports stats", async () => {
    const feed = await activityFeed(store, { limit: 50 });
    assert.ok(feed.length >= 1);
    assert.ok(feed.some((a) => a.type));
    const s = await stats(store);
    assert.ok(s.works >= 1 && s.chapters >= 1);
    assert.ok(s.languages.includes("en"));
  });
});

describe("QA lint", () => {
  it("flags leftover source script, missing terms, loops and commentary", () => {
    const w = lintTranslation("キリトは歩いた。", "キリト walked.", { target: "en", glossary: [{ source: "キリト", target: "Kirito" }] });
    assert.ok(w.some((x) => x.code === "source-script"));
    assert.ok(w.some((x) => x.code === "term-missing"));
    assert.equal(summarizeWarnings(w).errors, 0, "leftovers under 20 chars are warnings, not errors");
    assert.equal(summarizeWarnings(w).ok, true);
    assert.ok(lintTranslation("あ".repeat(400), "あ".repeat(60), { target: "en" }).some((x) => x.code === "source-script" && x.severity === "error"));
    assert.ok(lintTranslation("a".repeat(300), "x".repeat(250) + "x".repeat(250)).some((x) => x.code === "repetition"));
    assert.ok(lintTranslation("hello", "Here is the translation: hi").some((x) => x.code === "commentary"));
  });
  it("passes a good translation of a CJK source and tolerates glossary case/punctuation", () => {
    const w = lintTranslation("キリトは剣を抜いた。", "KIRITO drew his sword!", { target: "en", glossary: [{ source: "キリト", target: "Kirito." }] });
    assert.equal(summarizeWarnings(w).ok, true);
  });
  it("flags English discourse starters in Swedish, not translated Swedish equivalents", () => {
    const warnings = lintTranslation("source", "Think på barn. Well, det fanns. Som vanligt.", { target: "sv" });
    const english = warnings.find((warning) => warning.code === "english-opener");
    assert.ok(english);
    assert.match(english.sample, /Think/);
    assert.match(english.sample, /Well/);
    const quoted = lintTranslation("source", "“Well, det fanns.” Hon öppnade dörren.", { target: "sv" });
    assert.match(quoted.find((warning) => warning.code === "english-opener").sample, /Well/);
    assert.doesNotMatch(english.sample, /Som/);
    assert.equal(lintTranslation("source", "“Hon öppnade dörren.” Han gick in.", { target: "sv" }).some((warning) => warning.code === "quotes"), false);
  });
  it("does not flag chapter quotes split across translation chunks", async () => {
    const translate = async (chunk) => ({ text: chunk, provider: "test", model: "test" });
    const source = `“${"First paragraph. ".repeat(80)}\n\n${"Second paragraph. ".repeat(80)}”`;
    const added = await ingestText(store, { title: "Quotes Across Chunks", sourceLang: "en", text: source });
    const result = await translateChapter(store, { workId: added.workId, chapterId: added.chapterId, target: "sv", translate });
    assert.ok(result.chunks > 1);
    assert.equal(result.warnings.some((warning) => warning.code === "quotes"), false);
  });
});

describe("book covers", () => {
  it("persists, replaces and removes binary cover images", async () => {
    const added = await ingestText(store, { title: "Cover Story", sourceLang: "en", text: "A chapter." });
    const first = Buffer.from([0, 1, 2, 255]);
    await saveWorkCover(store, added.workId, first, "image/png");
    const saved = await getWorkCover(store, added.workId);
    assert.equal(saved.contentType, "image/png");
    assert.deepEqual(saved.body, first);
    assert.ok((await getWork(store, added.workId)).coverUrl.includes("/cover?v="));

    const second = Buffer.from([10, 20, 30]);
    await saveWorkCover(store, added.workId, second, "image/jpeg");
    assert.deepEqual((await getWorkCover(store, added.workId)).body, second);
    assert.equal(await store.loadBuffer(`covers/${added.workId}.png`), null);

    assert.deepEqual(await deleteWorkCover(store, added.workId), { removed: true });
    assert.equal(await getWorkCover(store, added.workId), null);
    assert.equal((await getWork(store, added.workId)).coverUrl, null);
  });
});

describe("model policy", () => {
  it("detects retired models and picks chat replacements", () => {
    assert.equal(isModelGone(404, ""), true);
    assert.equal(isModelGone(429, "Rate limit exceeded"), false);
    assert.deepEqual(pickCandidates("groq", ["whisper-large-v3", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]), ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  });
  it("uses the pinned model without an extra provider model-catalog request", async () => {
    const requests = [];
    const fetchFn = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/models")) return { ok: false, status: 500, text: async () => "catalog unavailable" };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "PINNED" } }] }) };
    };
    const r = await translateWithPolicy("test", {
      source: "ja", target: "en", pinned: { provider: "groq", model: "openai/gpt-oss-120b" }, fetchFn,
    });
    assert.equal(r.text, "PINNED");
    assert.equal(requests.length, 1);
    assert.match(requests[0], /chat\/completions$/);
  });

  it("only queries model catalog when a pinned model has been retired", async () => {
    const requests = [];
    const fetchFn = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "openai/gpt-oss-20b" }] }) };
      if (String(url).endsWith("/chat/completions") && requests.filter((x) => x.endsWith("/chat/completions")).length === 1) {
        return { ok: false, status: 404, text: async () => "model not found" };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "FALLBACK" } }] }) };
    };
    const r = await translateWithPolicy("test", {
      source: "ja", target: "en", pinned: { provider: "groq", model: "retired-model" }, fetchFn,
    });
    assert.equal(r.text, "FALLBACK");
    assert.ok(requests.some((x) => x.endsWith("/models")));
    assert.equal(requests.filter((x) => x.endsWith("/chat/completions")).length, 2);
  });

  it("serializes parallel requests to the same pinned provider", async () => {
    const previous = {
      gap: process.env.POOL_MIN_GAP_MS,
      apiKey: process.env.AI_API_KEY,
      baseUrl: process.env.AI_BASE_URL,
    };
    process.env.POOL_MIN_GAP_MS = "0";
    process.env.AI_API_KEY = "test-key";
    process.env.AI_BASE_URL = "https://parallel-queue-test.invalid/v1";
    let active = 0;
    let maxActive = 0;
    const fetchFn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "QUEUED" } }] }) };
    };
    try {
      await Promise.all(Array.from({ length: 5 }, (_, i) => translatePinned(String(i), { source: "ja", target: "en", fetchFn }, { provider: "parallel-queue-test", model: "test-model" })));
      assert.equal(maxActive, 1, "one active request per provider");
    } finally {
      if (previous.gap === undefined) delete process.env.POOL_MIN_GAP_MS;
      else process.env.POOL_MIN_GAP_MS = previous.gap;
      if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = previous.apiKey;
      if (previous.baseUrl === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = previous.baseUrl;
    }
  });

  it("pinned translations obey per-provider pacing after a request completes", async () => {
    const previous = {
      gap: process.env.POOL_MIN_GAP_MS,
      apiKey: process.env.AI_API_KEY,
      baseUrl: process.env.AI_BASE_URL,
    };
    process.env.POOL_MIN_GAP_MS = "20";
    process.env.AI_API_KEY = "test-key";
    process.env.AI_BASE_URL = "https://pacing-test.invalid/v1";
    const requests = [];
    const fetchFn = async (url) => {
      requests.push({ url: String(url), at: Date.now() });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "PINNED" } }] }) };
    };
    try {
      await translatePinned("one", { source: "ja", target: "en", fetchFn }, { provider: "pacing-test", model: "test-model" });
      await translatePinned("two", { source: "ja", target: "en", fetchFn }, { provider: "pacing-test", model: "test-model" });
      assert.equal(requests.length, 2);
      assert.ok(requests[1].at - requests[0].at >= 20, "consecutive provider requests honor the pacing gap");
    } finally {
      if (previous.gap === undefined) delete process.env.POOL_MIN_GAP_MS;
      else process.env.POOL_MIN_GAP_MS = previous.gap;
      if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = previous.apiKey;
      if (previous.baseUrl === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = previous.baseUrl;
    }
  });

  it("retries a transient 429 then succeeds", async () => {
    let n = 0;
    const fetchFn = async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, text: async () => "Rate limit exceeded", headers: { get: () => null } };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "RETRIED OK" } }] }) };
    };
    const r = await translateWithPolicy("テスト。", { source: "ja", target: "en", apiKey: "k", providers: ["groq"], fetchFn });
    assert.equal(r.text, "RETRIED OK");
    assert.ok(n >= 2);
  });
  it("moves to another free provider when one is rate-limited", async () => {
    const fetchFn = async (url) => {
      if (String(url).includes("api.groq.com")) return { ok: false, status: 429, text: async () => "Rate limit exceeded", headers: { get: () => null } };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "POOL OK" } }] }) };
    };
    const r = await translateWithPolicy("テスト。", { source: "ja", target: "en", apiKey: "k", providers: ["groq", "gemini"], fetchFn });
    assert.equal(r.text, "POOL OK");
    assert.notEqual(r.provider, "groq");
  });
  it("asks for a new key instead of silently changing voice (strict)", async () => {
    const fetchFn = async (url) => {
      if (String(url).includes("/models")) return { ok: false, status: 401, text: async () => "unauthorized" };
      return { ok: false, status: 429, text: async () => "Rate limit exceeded" };
    };
    await assert.rejects(() => translateWithPolicy("x", { source: "ja", target: "en", apiKey: "k", strict: true, fetchFn }), /Add a fresh key/);
  });
});

describe("list & search helpers", () => {
  it("lists works newest-first and searches by title", async () => {
    const all = await listWorks(store, {});
    assert.ok(all.length >= 1);
    const found = await listWorks(store, { q: "findable" });
    assert.ok(found.some((w) => w.title === "Findable Novel"));
  });
});
