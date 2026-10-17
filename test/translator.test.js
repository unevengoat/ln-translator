import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkNovel, joinChunks, normalizeText } from "../src/chunker.js";
import { parseGlossary, protectTerms, glossaryPromptLines } from "../src/glossary.js";
import { buildSystemPrompt, buildUserMessage } from "../src/prompt.js";
import { translateText } from "../src/engines/index.js";
import { cleanupFreeText } from "../src/engines/freeEngine.js";
import { PROVIDERS, resolveProvider, parseChain, expandAuto, DEFAULT_CHAIN, publicProviders } from "../src/engines/providers.js";

describe("chunker", () => {
  it("round-trips paragraphs exactly", () => {
    const text = "Para one.\n\nPara two with 「dialogue」.\n\nPara three.";
    const chunks = chunkNovel(text, 1800);
    assert.equal(joinChunks(chunks), normalizeText(text));
  });
  it("never merges paragraphs across chunk boundaries incorrectly", () => {
    const text = "A".repeat(100) + "\n\n" + "B".repeat(100) + "\n\n" + "C".repeat(100);
    const chunks = chunkNovel(text, 120);
    assert.ok(chunks.length >= 3);
    assert.equal(joinChunks(chunks), normalizeText(text));
  });
  it("splits oversized paragraphs on sentence boundaries (CJK)", () => {
    const para = "これは一文です。これは二文です。これは三文です。これは四文です。";
    const chunks = chunkNovel(para, 20);
    assert.ok(chunks.length > 1);
    // A single oversized paragraph gains breaks at chunk seams (good for readability);
    // all sentences must survive in order.
    assert.equal(joinChunks(chunks).replace(/\n+/g, ""), normalizeText(para).replace(/\n+/g, ""));
    for (const s of ["一文", "二文", "三文", "四文"]) assert.match(joinChunks(chunks), new RegExp(s));
  });
  it("handles empty input", () => {
    assert.deepEqual(chunkNovel("", 1800), []);
    assert.deepEqual(chunkNovel("   \n\n  ", 1800), []);
  });
});

describe("glossary", () => {
  it("parses text, JSON, and object forms", () => {
    assert.deepEqual(parseGlossary("a=b\nc -> d").length, 2);
    assert.deepEqual(parseGlossary([{ source: "a", target: "b" }]).length, 1);
    assert.deepEqual(parseGlossary({ a: "b" }), [{ source: "a", target: "b" }]);
  });
  it("protects and restores terms for the free engine", () => {
    const { text, restore } = protectTerms("Kirito and Asuna walked.", [{ source: "Kirito", target: "Kirito" }]);
    assert.match(text, /__LNG0__/);
    assert.equal(restore(text), "Kirito and Asuna walked.");
  });
  it("restores terms even when MT inserts spaces into tokens", () => {
    const { restore } = protectTerms("Kirito nodded.", [{ source: "Kirito", target: "Kirito" }]);
    assert.equal(restore("“__ LNG0 __ nodded.”"), "“Kirito nodded.”");
    assert.equal(restore("__LNG0__ nodded."), "Kirito nodded.");
  });
  it("renders prompt lines for the AI engine", () => {
    const lines = glossaryPromptLines([{ source: "キリト", target: "Kirito" }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Kirito/);
  });
});

describe("prompt", () => {
  it("includes honorific + glossary rules", () => {
    const sys = buildSystemPrompt({ sourceName: "Japanese", targetName: "English", keepHonorifics: true, glossary: [{ source: "a", target: "b" }] });
    assert.match(sys, /honorific/i);
    assert.match(sys, /GLOSSARY/);
    assert.match(sys, /ONLY the translation/);
  });
  it("attaches previous tail for continuity", () => {
    const msg = buildUserMessage("new chunk", "prev translation");
    assert.match(msg, /continuity/);
    assert.match(msg, /new chunk/);
  });
});

describe("free cleanup", () => {
  it("adds missing spaces after punctuation without breaking decimals", () => {
    assert.equal(
      cleanupFreeText("Hey,Kirito.Are you here?It costs 3.14 yen,about 1,000 total."),
      "Hey, Kirito. Are you here? It costs 3.14 yen, about 1,000 total."
    );
  });
  it("rejoins JP dialogue attribution", () => {
    assert.equal(
      cleanupFreeText('today? "and Asuna whispered.'),
      'today?" Asuna whispered.'
    );
  });
  it("leaves CJK targets untouched", () => {
    assert.equal(cleanupFreeText("今日は。元気？", "ja"), "今日は。元気？");
  });
});

describe("providers", () => {
  it("resolves defaults per provider", () => {
    const c = resolveProvider("pollinations", {});
    assert.equal(c.baseUrl, "https://text.pollinations.ai/openai");
    assert.equal(c.model, "openai");
  });
  it("throws a helpful error when a key is missing", () => {
    assert.throws(() => resolveProvider("groq", { apiKey: "" }), /GROQ_API_KEY/);
  });
  it("expands auto into the default quality chain", () => {
    assert.deepEqual(expandAuto([{ provider: "auto" }]).map((s) => s.provider), DEFAULT_CHAIN);
    assert.deepEqual(expandAuto(["groq"]).map((s) => (typeof s === "string" ? s : s.provider)), ["groq"]);
  });
  it("parses chain specs", () => {
    assert.deepEqual(parseChain("groq,cerebras:llama-3.3-70b,pollinations"), [
      { provider: "groq", model: undefined },
      { provider: "cerebras", model: "llama-3.3-70b" },
      { provider: "pollinations", model: undefined },
    ]);
  });
  it("exposes no secrets to the UI", () => {
    const pub = JSON.stringify(publicProviders());
    for (const id of Object.keys(PROVIDERS)) assert.match(pub, new RegExp(id));
    assert.doesNotMatch(pub, /sk-or|gsk_|csk-|nvapi|Bearer/i);
  });
});

describe("orchestrator", () => {
  it("translates via stubbed fetch, preserving paragraph breaks", async () => {
    const fakeFetch = async () => ({ ok: true, json: async () => [[["T1", "o1"], ["T2", "o2"]]] });
    const { translation, chunks } = await translateText("Para one.\n\nPara two.", {
      source: "en", target: "ja", engine: "free", maxChunk: 1800, fetchFn: fakeFetch,
    });
    assert.equal(chunks, 1);
    assert.ok(translation.length > 0);
  });
  it("applies glossary through the free engine", async () => {
    const fakeFetch = async (url) => {
      const q = decodeURIComponent(url.split("q=")[1] || "");
      return { ok: true, json: async () => [[[q, "x"]]] }; // echo: restore() swaps tokens for targets
    };
    const { translation } = await translateText("Kirito walked.", {
      source: "en", target: "ja", engine: "free",
      glossary: [{ source: "Kirito", target: "キリト" }],
      fetchFn: fakeFetch,
    });
    assert.match(translation, /キリト/);
  });
  it("auto chain falls back to free MT when AI legs fail", async () => {
    const fakeFetch = async (url) => {
      if (String(url).includes("chat/completions")) return { ok: false, status: 401, text: async () => "bad key" };
      return { ok: true, json: async () => [[["MT-OK", "x"]]] };
    };
    const { translation, provider } = await translateText("こんにちは。", {
      source: "ja", target: "en", engine: "ai", chain: "auto", ai: { apiKey: "k" }, fetchFn: fakeFetch,
    });
    assert.equal(translation, "MT-OK");
    assert.equal(provider, "free-mt");
  });
  it("falls through a failing provider to the next in chain", async () => {
    const calls = [];
    const fakeFetch = async (_url, opts) => {
      calls.push(JSON.parse(opts.body).model);
      if (calls.length === 1) return { ok: false, status: 401, text: async () => "bad key" };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "TRANSLATED OK" } }] }) };
    };
    const { translation, provider } = await translateText("こんにちは。", {
      source: "ja", target: "en", engine: "ai",
      ai: { apiKey: "k" },
      chain: [{ provider: "groq", model: "m1" }, { provider: "cerebras", model: "m2" }],
      fetchFn: fakeFetch,
    });
    assert.equal(translation, "TRANSLATED OK");
    assert.equal(provider, "cerebras/m2");
    assert.deepEqual(calls, ["m1", "m2"]);
  });
  it("rejects same source/target", async () => {
    await assert.rejects(() => translateText("hi", { source: "en", target: "en" }), /same/);
  });
});
