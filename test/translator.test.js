import { describe, it } from "node:test";
import assert from "node:assert/strict";
process.env.AI_MIN_INTERVAL_MS = "0";
import { chunkNovel, joinChunks, normalizeText } from "../src/chunker.js";
import { parseGlossary, protectTerms, glossaryPromptLines } from "../src/glossary.js";
import { buildSystemPrompt, buildUserMessage } from "../src/prompt.js";
import { translateText } from "../src/engines/index.js";
import { PROVIDERS, resolveProvider, parseChain, expandAuto, DEFAULT_CHAIN, publicProviders } from "../src/engines/providers.js";

describe("chunker", () => {
  it("round-trips paragraphs exactly", () => {
    const text = "Para one.\n\nPara two with 「dialogue」.\n\nPara three.";
    assert.equal(joinChunks(chunkNovel(text, 1800)), normalizeText(text));
  });
  it("splits oversized paragraphs on sentence boundaries (CJK)", () => {
    const para = "これは一文です。これは二文です。これは三文です。これは四文です。";
    const chunks = chunkNovel(para, 20);
    assert.ok(chunks.length > 1);
    assert.equal(joinChunks(chunks).replace(/\n+/g, ""), normalizeText(para).replace(/\n+/g, ""));
  });
  it("handles empty input", () => {
    assert.deepEqual(chunkNovel("", 1800), []);
  });
});

describe("glossary", () => {
  it("parses text, JSON, and object forms", () => {
    assert.equal(parseGlossary("a=b\nc -> d").length, 2);
    assert.deepEqual(parseGlossary({ a: "b" }), [{ source: "a", target: "b" }]);
  });
  it("protects and restores terms (and tolerates MT spacing)", () => {
    const { text, restore } = protectTerms("Kirito and Asuna walked.", [{ source: "Kirito", target: "Kirito" }]);
    assert.match(text, /__LNG0__/);
    assert.equal(restore(text), "Kirito and Asuna walked.");
    assert.equal(restore("“__ LNG0 __ walked.”"), "“Kirito walked.”");
  });
  it("renders prompt lines", () => {
    assert.match(glossaryPromptLines([{ source: "キリト", target: "Kirito" }])[0], /Kirito/);
  });
});

describe("prompt", () => {
  it("includes honorific, glossary, story notes and the reading level", () => {
    const sys = buildSystemPrompt({ sourceName: "Japanese", targetName: "English", keepHonorifics: true, glossary: [{ source: "a", target: "b" }], notes: "cold tone", difficulty: "easy" });
    assert.match(sys, /honorific/i);
    assert.match(sys, /GLOSSARY/);
    assert.match(sys, /cold tone/);
    assert.match(sys, /READING LEVEL — EASY/);
    assert.match(sys, /IDENTICAL at every reading level/);
    assert.match(sys, /NEVER leave any source-script character/);
    const hard = buildSystemPrompt({ sourceName: "Japanese", targetName: "German", difficulty: "hard" });
    assert.match(hard, /READING LEVEL — HARD/);
  });
  it("attaches previous tail for continuity", () => {
    assert.match(buildUserMessage("new chunk", "prev"), /continuity/);
  });
});

describe("providers", () => {
  it("resolves defaults per provider", () => {
    const c = resolveProvider("pollinations", {});
    assert.equal(c.baseUrl, "https://text.pollinations.ai/openai");
  });
  it("throws a helpful error when a key is missing", () => {
    assert.throws(() => resolveProvider("groq", { apiKey: "" }), /GROQ_API_KEY/);
  });
  it("quality chain is groq then gemini only (no keyless MT)", () => {
    assert.deepEqual(DEFAULT_CHAIN, ["groq", "gemini"]);
    assert.deepEqual(expandAuto([{ provider: "auto" }]).map((s) => s.provider), ["groq", "gemini"]);
    assert.ok(!PROVIDERS.free, "there must be no keyless free engine provider");
  });
  it("parses chain specs", () => {
    assert.deepEqual(parseChain("groq,cerebras:llama-3.3-70b"), [
      { provider: "groq", model: undefined },
      { provider: "cerebras", model: "llama-3.3-70b" },
    ]);
  });
  it("exposes no secrets to the UI", () => {
    const pub = JSON.stringify(publicProviders());
    assert.doesNotMatch(pub, /sk-or|gsk_|csk-|nvapi|Bearer/i);
  });
});

describe("orchestrator (AI only)", () => {
  const okFetch = (text = "TRANSLATED") => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) });

  it("translates and preserves paragraph breaks", async () => {
    const { translation, chunks, engine } = await translateText("Para one.\n\nPara two.", {
      source: "ja", target: "en", engine: "ai", ai: { apiKey: "k" }, chain: "auto", fetchFn: okFetch("OUT"),
    });
    assert.equal(chunks, 1);
    assert.equal(engine, "ai");
    assert.match(translation, /OUT/);
  });

  it("uses the groq → gemini chain and reports the provider", async () => {
    const { provider } = await translateText("テスト。", { source: "ja", target: "en", engine: "ai", ai: { apiKey: "k" }, chain: "auto", fetchFn: okFetch("X") });
    assert.equal(provider, "groq/openai/gpt-oss-120b");
  });

  it("falls through to gemini when groq fails, and never to keyless MT", async () => {
    let calls = [];
    const fetchFn = async (url, opts) => {
      const model = JSON.parse(opts.body).model;
      calls.push(model);
      if (String(url).includes("api.groq.com")) {
        if (String(url).endsWith("/models")) return { ok: false, status: 401, text: async () => "no" };
        return { ok: false, status: 429, text: async () => "Rate limit exceeded" };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: "GEMINI OK" } }] }) };
    };
    const { translation, provider } = await translateText("テスト。", { source: "ja", target: "en", engine: "ai", ai: { apiKey: "k" }, chain: "auto", fetchFn });
    assert.equal(translation, "GEMINI OK");
    assert.equal(provider, "gemini/gemini-flash-latest");
  });

  it("throws (asking for a key) when every model fails — no free-MT fallback", async () => {
    const fetchFn = async (url) => {
      if (String(url).endsWith("/models")) return { ok: false, status: 401, text: async () => "no" };
      return { ok: false, status: 429, text: async () => "Rate limit exceeded" };
    };
    await assert.rejects(
      () => translateText("テスト。", { source: "ja", target: "en", engine: "ai", ai: { apiKey: "k" }, chain: "auto", fetchFn }),
      /Add a fresh key/
    );
  });

  it("rejects same source/target", async () => {
    await assert.rejects(() => translateText("hi", { source: "en", target: "en" }), /same/);
  });

  it("stops on a failing single provider when a chain is pinned", async () => {
    const fetchFn = async () => ({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(() => translateText("テスト。", { source: "ja", target: "en", engine: "ai", chain: [{ provider: "groq" }], ai: { apiKey: "k" }, fetchFn }), /All models failed/);
  });
});
