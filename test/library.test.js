import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { ingestText, translateChapter, correctTerm, listWorks, getWork, getChapter, stats } from "../src/library.js";
import { mergeTerms, termsGlossary, canonicalFor, extractCandidates } from "../src/terms.js";
import { isModelGone, pickCandidates, translateWithPolicy } from "../src/engines/models.js";

let dir, store;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ln-lib-"));
  store = new Store(dir);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

// Stub translator: deterministic, records how it was called.
const makeTranslator = () => {
  const calls = [];
  const translate = async (chunk, opts) => {
    calls.push({ chunk, pinned: opts.pinned, glossary: opts.glossary });
    const glossaryText = (opts.glossary || []).map((g) => g.target).join(",");
    return { text: `[${opts.target}] ${chunk}${glossaryText ? " {" + glossaryText + "}" : ""}`, provider: opts.pinned?.provider || "groq", model: opts.pinned?.model || "openai/gpt-oss-120b" };
  };
  translate.calls = calls;
  return translate;
};

const CHAPTER_EN = "Kirito walked to the window.\n\nHe thought of Asuna.\n\nThe town of Aincrad sprawled below.";
const CHAPTER_EN_2 = "Kirito drew his sword.\n\nThe boss roared.";

describe("ingest & dedupe", () => {
  it("creates a work and chapter, then recognises the same text as a duplicate", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN, translate: t });
    assert.ok(a.workId && a.chapterId && a.created);
    const b = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN, translate: t });
    assert.equal(b.duplicate, true);
    assert.equal(b.chapterId, a.chapterId);
    const work = await getWork(store, a.workId);
    assert.equal(work.chapters.length, 1);
  });

  it("adds extra chapters to the SAME work and keeps old versions", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN, translate: t });
    const c2 = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN_2, chapterIndex: 2, chapterTitle: "Ch 2", translate: t });
    assert.equal(c2.workId, a.workId);
    // re-upload chapter 1 with new text → same chapter id, new version
    const v = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN + "\n\nExtra line.", chapterIndex: 1, translate: t });
    assert.equal(v.chapterId, a.chapterId);
    assert.equal(v.version, true);
    const work = await getWork(store, v.workId);
    assert.equal(work.chapters.length, 2);
    const ch1 = work.chapters.find((c) => c.index === 1);
    assert.equal(ch1.versionCount, 2);
  });

  it("keeps stories with different titles separate", async () => {
    const t = makeTranslator();
    const x = await ingestText(store, { title: "Other Story", sourceLang: "en", text: CHAPTER_EN, translate: t });
    const y = await ingestText(store, { title: "Test LN", author: "A", sourceLang: "en", text: CHAPTER_EN, translate: t });
    assert.notEqual(x.workId, y.workId);
  });

  it("auto-translates a freshly ingested chapter into several languages", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, {
      title: "Auto Multi", sourceLang: "ja", text: "キリトは剣を抜いた。\n\nアスナは頷いた。",
      autoTranslateTo: ["en", "es", "sv"], translate: t,
    });
    assert.equal(a.translateError, undefined);
    assert.deepEqual(a.translated, ["en", "es", "sv"]);
    for (const lang of ["en", "es", "sv"]) {
      const ch = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang });
      assert.ok(ch.translation && ch.translation.length > 0, `expected a ${lang} translation`);
      assert.ok(ch.translation.startsWith(`[${lang}]`));
    }
  });
});

describe("translation memory + model pinning", () => {
  it("translates once, then serves the same chapter from memory", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "TM Story", sourceLang: "ja", text: "こんにちは。\n\nさようなら。", translate: t });
    const first = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t });
    assert.equal(first.cached, false);
    const before = t.calls.length;
    const second = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t });
    assert.equal(second.cached, true);
    assert.equal(second.translation, first.translation);
    assert.equal(t.calls.length, before, "no model calls for a cached chapter");
  });

  it("pins the story to the model that translated it", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Pin Story", sourceLang: "ja", text: "テスト。", translate: t });
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "sv", translate: t });
    const work = await getWork(store, a.workId);
    assert.deepEqual(work.models.sv, { provider: "groq", model: "openai/gpt-oss-120b" });
    // new chapter in same story → translator receives the pinned model
    const c2 = await ingestText(store, { title: "Pin Story", sourceLang: "ja", text: "続き。", chapterIndex: 2, translate: t });
    const t2 = makeTranslator();
    await translateChapter(store, { workId: c2.workId, chapterId: c2.chapterId, target: "sv", translate: t2 });
    assert.equal(t2.calls[0].pinned.provider, "groq");
    assert.equal(t2.calls[0].pinned.model, "openai/gpt-oss-120b");
  });

  it("feeds the story's terms to the translator", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Gloss Story", sourceLang: "ja", text: "キリトは歩いた。", translate: t });
    await store.update((db) => mergeTerms(db, a.workId, "en", [{ source: "キリト", translation: "Kirito" }]));
    await store.update((db) => { db.works[a.workId].termExtracted = { en: true }; });
    const t2 = makeTranslator();
    await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.ok(t2.calls[0].glossary.some((g) => g.source === "キリト" && g.target === "Kirito"));
  });
});

describe("terms", () => {
  it("keeps Latin originals automatically and CJK from first sighting", () => {
    assert.deepEqual(canonicalFor("Kirito"), { canonical: "Kirito", auto: true });
    assert.equal(canonicalFor("キリト").auto, false);
    const db = { terms: {} };
    mergeTerms(db, "w1", "en", [{ source: "キリト", translation: "Kirito" }]);
    mergeTerms(db, "w1", "en", [{ source: "キリト", translation: "Kirito-sama" }]);
    const term = db.terms["w1 キリト"];
    assert.equal(term.langs.en.canonical, "Kirito");
    assert.deepEqual(term.langs.en.variants, ["Kirito-sama"]);
    assert.deepEqual(termsGlossary(db, "w1", "en"), [{ source: "キリト", target: "Kirito" }]);
  });

  it("stores a canonical per target language on the same term", () => {
    const db = { terms: {} };
    mergeTerms(db, "w1", "en", [{ source: "キリト", translation: "Kirito" }]);
    mergeTerms(db, "w1", "sv", [{ source: "キリト", translation: "Kirito" }]);
    assert.equal(Object.keys(db.terms).length, 1);
    assert.equal(termsGlossary(db, "w1", "sv")[0].target, "Kirito");
    assert.equal(termsGlossary(db, "w1", "ja").length, 0);
  });

  it("extracts katakana and Latin name candidates", () => {
    const c = extractCandidates("キリト met Asuna in Tokyo.");
    assert.ok(c.includes("キリト"));
    assert.ok(c.includes("Asuna"));
    assert.ok(c.includes("Tokyo"));
  });
});

describe("corrections propagate", () => {
  it("renames a term across saved translations and memory, no re-translation", async () => {
    const t = makeTranslator();
    const a = await ingestText(store, { title: "Fix Story", sourceLang: "ja", text: "キリトは窓を見た。", translate: t });
    await store.update((db) => mergeTerms(db, a.workId, "en", [{ source: "キリト", translation: "Kirito" }]));
    await store.update((db) => { db.works[a.workId].termExtracted = { en: true }; });
    const t2 = makeTranslator();
    // translator emits the auto form "Kirito"
    const tr = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.match(tr.translation, /Kirito/);
    const before = t2.calls.length;
    // user decides the westernization should be "Keith"
    const r = await correctTerm(store, { workId: a.workId, lang: "en", source: "キリト", canonical: "Keith" });
    assert.equal(r.chapterRewrites, 1);
    const ch = await getChapter(store, { workId: a.workId, chapterId: a.chapterId, lang: "en" });
    assert.match(ch.translation, /Keith/);
    assert.doesNotMatch(ch.translation, /Kirito/);
    // memory no longer serves the old form
    const again = await translateChapter(store, { workId: a.workId, chapterId: a.chapterId, target: "en", translate: t2 });
    assert.doesNotMatch(again.translation, /Kirito/);
    assert.equal(t2.calls.length, before, "correction must not re-translate");
  });
});

describe("model policy", () => {
  it("detects retired models from status/body", () => {
    assert.equal(isModelGone(404, ""), true);
    assert.equal(isModelGone(410, ""), true);
    assert.equal(isModelGone(400, "The model `x` does not exist or you do not have access to it."), true);
    assert.equal(isModelGone(429, "Rate limit exceeded"), false);
  });
  it("picks chat-capable replacement candidates and ignores non-chat", () => {
    const picked = pickCandidates("groq", ["whisper-large-v3", "llama-prompt-guard-2-22m", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
    assert.deepEqual(picked, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  });
  it("groq primary wins when available", async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "GROQ OK" } }] }) });
    const r = await translateWithPolicy("テスト。", { source: "ja", target: "en", apiKey: "k", fetchFn });
    assert.equal(r.text, "GROQ OK");
    assert.equal(r.provider, "groq");
  });
  it("falls back to gemini only when groq is unavailable", async () => {
    const fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (String(url).includes("api.groq.com")) {
        if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "openai/gpt-oss-120b" }, { id: "qwen/qwen3.8-27b" }] }) };
        return { ok: false, status: 404, text: async () => "The model does not exist" };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "GEMINI:" + body.model } }] }) };
    };
    const r = await translateWithPolicy("テスト。", { source: "ja", target: "en", apiKey: "k", fetchFn });
    assert.equal(r.provider, "gemini");
    assert.match(r.text, /GEMINI:/);
  });
  it("throws and asks for a new key instead of silently changing voice (strict)", async () => {
    const fetchFn = async (url) => {
      if (String(url).includes("/models")) return { ok: false, status: 401, text: async () => "unauthorized" };
      return { ok: false, status: 429, text: async () => "Rate limit exceeded" };
    };
    await assert.rejects(
      () => translateWithPolicy("テスト。", { source: "ja", target: "en", apiKey: "k", strict: true, fetchFn }),
      /Add a fresh key/
    );
  });
});

describe("library stats", () => {
  it("counts works, chapters, translations and terms", async () => {
    const s = await stats(store);
    assert.ok(s.works >= 1);
    assert.ok(s.chapters >= 1);
    assert.ok(s.terms >= 1);
    assert.ok(Array.isArray(s.languages));
  });
  it("search finds stories by title", async () => {
    const found = await listWorks(store, { q: "tm story" });
    assert.ok(found.some((w) => w.title === "TM Story"));
  });
});
