// Web server (zero dependencies): serves public/ UI + JSON API + library.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateText } from "./engines/index.js";
import { parseGlossary } from "./glossary.js";
import { publicProviders } from "./engines/providers.js";
import { LANGUAGES, normalizeCode } from "./languages.js";
import { globalStore } from "./store.js";
import { ingestText, listWorks, getWork, getChapter, translateChapter, correctTerm, suggestTerms, stats } from "./library.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "..", "public");
const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.env.PORT || "3000", 10);
const MAX_JSON = 8_000_000; // ~8MB of text per upload

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const store = globalStore();

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC, path.normalize(p).replace(/^[/\\]+/, ""));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error("dir");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end("not found"); }
}

function readJson(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("Request too large — split the chapter or use the CLI.")); req.destroy(); return; } parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}

const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  const q = Object.fromEntries(url.searchParams);
  const seg = pathname.split("/").filter(Boolean); // e.g. ["api","works","w_1","chapters","c_2"]
  const method = req.method;

  try {
    if (method === "GET" && pathname === "/api/languages") return json(res, 200, LANGUAGES);
    if (method === "GET" && pathname === "/api/providers") return json(res, 200, publicProviders());
    if (method === "GET" && pathname === "/api/stats") return json(res, 200, await stats(store));

    /* ---- reader / paste translate (no persistence) ---- */
    if (method === "POST" && pathname === "/api/translate") {
      const b = await readJson(req);
      if (!b.text?.trim()) throw new Error("No text provided.");
      if (!b.target) throw new Error("No target language selected.");
      const result = await translateText(b.text, {
        source: b.source || "auto",
        target: b.target,
        engine: b.engine || "free",
        maxChunk: Math.min(Math.max(parseInt(b.maxChunk, 10) || 1800, 200), 6000),
        keepHonorifics: b.keepHonorifics !== false,
        formality: b.formality || "match",
        glossary: parseGlossary(b.glossary),
        ai: { provider: b.ai?.provider || b.provider || "custom", baseUrl: b.ai?.baseUrl, apiKey: b.ai?.apiKey, model: b.ai?.model || b.model },
        chain: b.chain,
      });
      return json(res, 200, result);
    }

    /* ---- library: works ---- */
    if (pathname === "/api/works" && method === "GET") return json(res, 200, await listWorks(store, { q: q.q || "" }));
    if (pathname === "/api/works" && method === "POST") {
      const b = await readJson(req);
      const result = await ingestText(store, {
        title: b.title, author: b.author, sourceLang: normalizeCode(b.sourceLang || b.source || "auto"),
        sourceUrl: b.sourceUrl, chapterTitle: b.chapterTitle,
        chapterIndex: b.chapterIndex != null && b.chapterIndex !== "" ? parseInt(b.chapterIndex, 10) : null,
        text: b.text, autoTranslateTo: (b.autoTranslateTo || []).map(normalizeCode),
      });
      return json(res, 200, {
        workId: result.workId, chapterId: result.chapterId,
        duplicate: !!result.duplicate, created: !!result.created, version: !!result.version,
        termsAdded: result.termsAdded || 0, translated: result.translated || [],
        translateError: result.translateError, termExtraction: result.termExtraction,
        url: `/work/${result.workId}`,
      });
    }

    if (seg[0] === "api" && seg[1] === "works" && seg[2]) {
      const workId = seg[2];
      if (seg.length === 3 && method === "GET") {
        const work = await getWork(store, workId);
        return work ? json(res, 200, work) : json(res, 404, { error: "Unknown story" });
      }
      if (seg[3] === "terms" && seg.length === 4 && method === "GET") {
        return json(res, 200, await suggestTerms(store, { workId, lang: normalizeCode(q.lang || "en") }));
      }
      if (seg[3] === "terms" && seg.length === 4 && method === "POST") {
        const b = await readJson(req);
        return json(res, 200, await correctTerm(store, {
          workId, lang: normalizeCode(b.lang || "en"), source: b.source,
          canonical: b.canonical, forms: b.forms || [],
        }));
      }
      if (seg[3] === "chapters" && seg[4]) {
        const chapterId = seg[4];
        if (seg.length === 5 && method === "GET") {
          const ch = await getChapter(store, { workId, chapterId, lang: normalizeCode(q.lang || "") });
          return ch ? json(res, 200, ch) : json(res, 404, { error: "Unknown chapter" });
        }
        if (seg[5] === "translate" && method === "POST") {
          const b = await readJson(req);
          return json(res, 200, await translateChapter(store, {
            workId, chapterId, target: normalizeCode(b.target), force: !!b.force, strict: b.strict !== false,
          }));
        }
      }
    }

    if (method === "GET") return serveStatic(req, res);
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  console.log(`LN Translator: http://localhost:${PORT}`);
  console.log(`Library data dir: ${dir}${process.env.DATA_DIR ? "" : " (set DATA_DIR to a mounted disk for persistence)"}`);
  const models = [process.env.GROQ_API_KEY && "groq(primary)", process.env.GEMINI_API_KEY && "gemini(backup)"].filter(Boolean);
  console.log(`Models configured: ${models.length ? models.join(", ") : "none — AI endpoints will report that a key is needed"}`);
});
