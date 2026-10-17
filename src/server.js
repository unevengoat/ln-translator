// Web server (zero dependencies): public/ UI, JSON API, shared library.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateText } from "./engines/index.js";
import { parseGlossary } from "./glossary.js";
import { publicProviders } from "./engines/providers.js";
import { LANGUAGES, normalizeCode } from "./languages.js";
import { globalStore } from "./store.js";
import { parseBuffer } from "./files.js";
import {
  ingestText, bulkIngest, workIdFor, listWorks, getWork, getChapter, translateChapter,
  correctTerm, suggestTerms, stats, searchLibrary, activityFeed, updateWork, deleteChapter, deleteWork,
  restoreVersion, importGlossary, exportGlossary, splitChapters, sortChapters,
  DIFFICULTIES, DEFAULT_DIFFICULTY, cleanTranslationArtifacts,
} from "./library.js";
import { normalizeDifficulty } from "./qa.js";
import { PRIMARY, BACKUP } from "./engines/models.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "..", "public");
const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.env.PORT || "3000", 10);
const MAX_JSON = 25_000_000;
const EDIT_TOKEN = process.env.EDIT_TOKEN || "";
const store = globalStore();

/* ------------------------------------------------------------------- jobs
 * Long work (translating a whole volume/story) must never run inside one HTTP
 * request: the free host's proxy times out and the client sees a 502. Instead
 * we return a job id immediately and the client polls /api/jobs/:id. */
const jobs = new Map();
let jobSeq = 0;
function startJob(type, meta = {}) {
  const id = `job_${(++jobSeq).toString(36)}${Date.now().toString(36)}`;
  const job = { id, type, state: "running", done: 0, total: 0, error: null, startedAt: Date.now(), ...meta };
  jobs.set(id, job);
  if (jobs.size > 60) jobs.delete(jobs.keys().next().value);
  return job;
}
function runJob(job, fn) {
  Promise.resolve()
    .then(fn)
    .then((result) => { job.state = "done"; job.result = result; })
    .catch((e) => { job.state = "error"; job.error = e.message; })
    .finally(() => { job.finishedAt = Date.now(); });
  return job;
}

/** Translate every chapter of a story into each target × reading level, as a job. */
function startTranslateJob(workId, targets, { force = false, difficulties = [DEFAULT_DIFFICULTY] } = {}) {
  const levels = difficulties.map(normalizeDifficulty);
  const job = startJob("translate", { workId, targets, difficulties: levels });
  runJob(job, async () => {
    const db = await store.load();
    const work = db.works[workId];
    if (!work) throw new Error("Unknown story: " + workId);
    const chapters = sortChapters(work);
    job.total = chapters.length * targets.length * levels.length;
    const results = [];
    for (const target of targets) {
      for (const level of levels) {
        for (const chapter of chapters) {
          job.current = `${chapter.title} → ${target} (${level})`;
          try {
            const r = await translateChapter(store, { workId, chapterId: chapter.id, target, difficulty: level, force });
            results.push({ chapterId: chapter.id, target, difficulty: level, ok: true, cached: r.cached });
          } catch (e) {
            results.push({ chapterId: chapter.id, target, difficulty: level, ok: false, error: e.message.slice(0, 200) });
            job.errors = [...(job.errors || []), `${chapter.title} → ${target} (${level}): ${e.message.slice(0, 120)}`];
          }
          job.done++;
        }
      }
    }
    job.ok = results.filter((r) => r.ok).length;
    job.failed = results.filter((r) => !r.ok).length;
    return { ok: job.ok, failed: job.failed, results };
  });
  return job;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };

/* ------------------------------------------------------------ rate limiting */
const buckets = new Map();
function rateLimit(ip, kind) {
  const limit = kind === "write" ? { max: 300, window: 3600_000 } : { max: 3000, window: 60_000 };
  const now = Date.now();
  const key = `${ip}|${kind}`;
  const b = buckets.get(key);
  if (!b || now > b.resetAt) { buckets.set(key, { count: 1, resetAt: now + limit.window }); return null; }
  b.count++;
  if (b.count > limit.max) return Math.ceil((b.resetAt - now) / 1000);
  return null;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k); }, 300_000).unref?.();

/* --------------------------------------------------------------- utilities */
async function serveStatic(req, res, overridePath) {
  let p = overridePath || decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC, path.normalize(p).replace(/^[/\\]+/, ""));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error("dir");
    // App shell files always revalidate so a deploy is picked up immediately;
    // other assets can be cached briefly.
    const ext = path.extname(file).toLowerCase();
    const revalidate = [".html", ".js", ".css", ".webmanifest"].includes(ext) || p === "/sw.js";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": revalidate ? "no-cache" : "public, max-age=300" });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end("not found"); }
}

function readBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error(`Request too large (${Math.round(limit / 1e6)}MB max) — split it or use the CLI.`)); req.destroy(); return; } parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
const readJson = async (req, limit) => { const raw = await readBody(req, limit); try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("Invalid JSON body"); } };
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) }); res.end(s); };
const text = (res, code, body, type = "text/plain; charset=utf-8") => { res.writeHead(code, { "Content-Type": type }); res.end(body); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const { pathname } = url;
  const q = Object.fromEntries(url.searchParams);
  const seg = pathname.split("/").filter(Boolean);
  const method = req.method;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

  try {
    // ---- rate limit + optional edit token on writes
    if (method !== "GET" && method !== "HEAD") {
      const wait = rateLimit(ip, "write");
      if (wait) return json(res, 429, { error: `Too many writes — retry in ${wait}s.` });
      if (method !== "POST" || pathname !== "/api/translate") {
        if (EDIT_TOKEN && req.headers["x-edit-token"] !== EDIT_TOKEN) return json(res, 401, { error: "Editing requires the edit token (set by the site owner)." });
      }
    } else {
      const wait = rateLimit(ip, "read");
      if (wait) return json(res, 429, { error: `Slow down — retry in ${wait}s.` });
    }

    /* ---- static extras ---- */
    if (method === "GET" && pathname === "/robots.txt") return text(res, 200, "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n");
    if (method === "GET" && pathname === "/sitemap.xml") {
      const works = await listWorks(store, {});
      const urls = works.map((w) => `  <url><loc>/#/work/${w.id}</loc><lastmod>${new Date(w.updatedAt || w.createdAt).toISOString()}</lastmod></url>`).join("\n");
      return text(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, "application/xml");
    }

    /* ---- meta / health ---- */
    if (method === "GET" && pathname === "/api") return json(res, 200, {
      name: "LN Translator API", version: 3, storage: store.backendName,
      difficulties: DIFFICULTIES,
      models: { primary: `${PRIMARY.provider}/${PRIMARY.model}`, backup: `${BACKUP.provider}/${BACKUP.model}` },
      endpoints: [
        "GET /api/languages", "GET /api/providers", "GET /api/stats", "GET /api/health", "GET /api/activity",
        "GET /api/jobs", "GET /api/jobs/:id", "GET /api/search?q=", "GET /api/works?q=", "POST /api/works", "POST /api/works/bulk",
        "GET /api/works/:id", "PATCH /api/works/:id", "DELETE /api/works/:id",
        "GET /api/works/:id/chapters/:chapterId?lang=", "DELETE /api/works/:id/chapters/:chapterId",
        "POST /api/works/:id/chapters/:chapterId/translate", "POST /api/works/:id/chapters/:chapterId/versions/:hash/restore",
        "POST /api/works/:id/translate-all", "GET /api/works/:id/terms?lang=", "POST /api/works/:id/terms",
        "GET /api/works/:id/glossary?lang=&format=csv|json", "POST /api/works/:id/glossary",
        "GET /api/export", "POST /api/import", "POST /api/translate",
      ],
    });
    if (method === "GET" && pathname === "/api/health") {
      const s = await stats(store);
      const storageInfo = store.backend?.info ? await store.backend.info().catch(() => null) : null;
      return json(res, 200, {
        ok: true, at: Date.now(), storage: store.backendName, storageDescription: store.describe(), storageInfo,
        keys: { groq: !!process.env.GROQ_API_KEY, gemini: !!process.env.GEMINI_API_KEY },
        editTokenRequired: !!EDIT_TOKEN, stats: s,
      });
    }
    if (method === "POST" && pathname === "/api/reload") {
      await store.reload();
      return json(res, 200, { reloaded: true, at: Date.now() });
    }
    if (method === "GET" && pathname === "/api/jobs") return json(res, 200, [...jobs.values()].slice(-20).reverse());
    if (method === "GET" && /^\/api\/jobs\/[A-Za-z0-9_]+$/.test(pathname)) {
      const job = jobs.get(pathname.split("/").pop());
      return job ? json(res, 200, job) : json(res, 404, { error: "Unknown job" });
    }
    if (method === "GET" && pathname === "/api/languages") return json(res, 200, LANGUAGES);
    if (method === "GET" && pathname === "/api/providers") return json(res, 200, publicProviders());
    if (method === "GET" && pathname === "/api/stats") return json(res, 200, await stats(store));
    if (method === "GET" && pathname === "/api/activity") return json(res, 200, await activityFeed(store, { limit: +q.limit || 40 }));
    if (method === "GET" && pathname === "/api/search") return json(res, 200, await searchLibrary(store, { q: q.q || "", limit: +q.limit || 30 }));

    /* ---- backup / restore ---- */
    if (method === "GET" && pathname === "/api/export") {
      const dump = await store.exportAll();
      return json(res, 200, dump);
    }
    if (method === "POST" && pathname === "/api/import") {
      const body = await readJson(req);
      const payload = body.payload || body;
      return json(res, 200, await store.importAll(payload));
    }

    /* ---- one-off translate (no persistence) ---- */
    if (method === "POST" && pathname === "/api/translate") {
      const b = await readJson(req);
      if (!b.text?.trim()) throw new Error("No text provided.");
      if (!b.target) throw new Error("No target language selected.");
      const result = await translateText(b.text, {
        source: b.source || "auto", target: b.target, engine: "ai",
        maxChunk: Math.min(Math.max(parseInt(b.maxChunk, 10) || 1800, 200), 6000),
        keepHonorifics: b.keepHonorifics !== false, formality: b.formality || "match",
        glossary: parseGlossary(b.glossary),
        ai: { provider: b.ai?.provider || b.provider || "custom", baseUrl: b.ai?.baseUrl, apiKey: b.ai?.apiKey, model: b.ai?.model || b.model },
        chain: b.chain,
      });
      return json(res, 200, result);
    }

    /* ---- library ---- */
    if (pathname === "/api/works" && method === "GET") {
      store.maybeRefresh?.(120000).catch(() => {});
      return json(res, 200, await listWorks(store, { q: q.q || "" }));
    }
    if (pathname === "/api/works" && method === "POST") {
      const b = await readJson(req);
      const targets = (b.autoTranslateTo || []).map(normalizeCode).filter(Boolean);
      const result = await ingestText(store, {
        title: b.title, author: b.author, sourceLang: normalizeCode(b.sourceLang || b.source || "auto"),
        sourceUrl: b.sourceUrl, chapterTitle: b.chapterTitle, volume: b.volume || "",
        chapterIndex: b.chapterIndex != null && b.chapterIndex !== "" ? parseInt(b.chapterIndex, 10) : null,
        text: b.text, autoTranslateTo: [], settings: b.settings || {},
      });
      const job = targets.length ? startTranslateJob(result.workId, targets) : null;
      return json(res, 200, { ...result, jobId: job?.id || null, url: `/#/work/${result.workId}` });
    }
    if (pathname === "/api/parse-file" && method === "POST") {
      const b = await readJson(req);
      if (!b.dataBase64) throw new Error("No file data provided.");
      const buf = Buffer.from(String(b.dataBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
      const parsed = await parseBuffer(b.name || "upload.txt", buf);
      const chapters = splitChapters(parsed);
      return json(res, 200, { name: b.name, chars: parsed.length, chapters: chapters.length, text: parsed });
    }

    if (pathname === "/api/works/bulk" && method === "POST") {
      const b = await readJson(req);
      const targets = (b.autoTranslateTo || []).map(normalizeCode).filter(Boolean);
      const levels = (b.difficulties?.length ? b.difficulties : [DEFAULT_DIFFICULTY]).map(normalizeDifficulty);
      const workId = await workIdFor(store, { title: b.title, author: b.author, sourceUrl: b.sourceUrl });
      // Ingest + translate as one background job so a whole volume can't time out.
      const job = startJob("ingest", { workId, targets, difficulties: levels });
      job.total = 1 + targets.length * levels.length;
      runJob(job, async () => {
        const result = await bulkIngest(store, {
          title: b.title, author: b.author, sourceLang: normalizeCode(b.sourceLang || b.source || "auto"),
          sourceUrl: b.sourceUrl, volume: b.volume || "", text: b.text, chapters: b.chapters,
          autoTranslateTo: [], settings: b.settings || {},
        });
        job.chapters = result.chapters;
        job.done = 1;
        job.current = `saved ${result.chapters.length} chapter(s)`;
        for (const target of targets) {
          for (const level of levels) {
            for (const c of result.chapters) {
              job.current = `${c.title} → ${target} (${level})`;
              try { await translateChapter(store, { workId, chapterId: c.chapterId, target, difficulty: level }); }
              catch (e) { job.errors = [...(job.errors || []), `${c.title} → ${target} (${level}): ${e.message.slice(0, 120)}`]; }
            }
            job.done++;
          }
        }
        return { workId, chapters: result.chapters.length, targets, difficulties: levels };
      });
      return json(res, 202, { jobId: job.id, workId, url: `/#/work/${workId}` });
    }
    if (pathname === "/api/works/preview-split" && method === "POST") {
      const b = await readJson(req);
      const chapters = splitChapters(b.text || "", { defaultVolume: b.volume || "" });
      const volumes = [...new Set(chapters.map((c) => c.volume).filter(Boolean))];
      return json(res, 200, {
        count: chapters.length, volumes,
        chapters: chapters.map((c) => ({ title: c.title, volume: c.volume, chars: c.text.length })),
      });
    }

    if (seg[0] === "api" && seg[1] === "works" && seg[2]) {
      const workId = seg[2];

      if (seg.length === 3 && method === "GET") {
        const work = await getWork(store, workId);
        return work ? json(res, 200, work) : json(res, 404, { error: "Unknown story" });
      }
      if (seg.length === 3 && method === "PATCH") {
        const b = await readJson(req);
        return json(res, 200, await updateWork(store, workId, {
          title: b.title, author: b.author, sourceUrl: b.sourceUrl,
          sourceLang: b.sourceLang ? normalizeCode(b.sourceLang) : undefined, settings: b.settings,
        }));
      }
      if (seg.length === 3 && method === "DELETE") return json(res, 200, await deleteWork(store, { workId }));

      if (seg[3] === "translate-all" && method === "POST") {
        const b = await readJson(req);
        const targets = b.targets?.length ? b.targets.map(normalizeCode) : [normalizeCode(b.target || "en")];
        const levels = (b.difficulties?.length ? b.difficulties : [b.difficulty || DEFAULT_DIFFICULTY]).map(normalizeDifficulty);
        const job = startTranslateJob(workId, targets, { force: !!b.force, difficulties: levels });
        return json(res, 200, { jobId: job.id, workId, targets, difficulties: levels });
      }

      if (seg[3] === "terms" && seg.length === 4 && method === "GET") {
        return json(res, 200, await suggestTerms(store, { workId, lang: normalizeCode(q.lang || "en") }));
      }
      if (seg[3] === "terms" && seg.length === 4 && method === "POST") {
        const b = await readJson(req);
        return json(res, 200, await correctTerm(store, { workId, lang: normalizeCode(b.lang || "en"), source: b.source, canonical: b.canonical, forms: b.forms || [] }));
      }
      if (seg[3] === "glossary" && seg.length === 4 && method === "GET") {
        const lang = normalizeCode(q.lang || "en");
        const body = await exportGlossary(store, { workId, lang, format: q.format || "csv" });
        const name = `${workId}.${lang}.${q.format === "json" ? "json" : "csv"}`;
        res.writeHead(200, { "Content-Type": q.format === "json" ? "application/json" : "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });
        return res.end(body);
      }
      if (seg[3] === "glossary" && seg.length === 4 && method === "POST") {
        const b = await readJson(req);
        return json(res, 200, await importGlossary(store, { workId, lang: normalizeCode(b.lang || "en"), data: b.data }));
      }

      if (seg[3] === "chapters" && seg[4]) {
        const chapterId = seg[4];
        if (seg.length === 5 && method === "GET") {
          const ch = await getChapter(store, { workId, chapterId, lang: normalizeCode(q.lang || ""), difficulty: q.difficulty || DEFAULT_DIFFICULTY });
          return ch ? json(res, 200, ch) : json(res, 404, { error: "Unknown chapter" });
        }
        if (seg.length === 5 && method === "DELETE") return json(res, 200, await deleteChapter(store, { workId, chapterId }));
        if (seg[5] === "translate" && method === "POST") {
          const b = await readJson(req);
          const target = normalizeCode(b.target);
          const level = normalizeDifficulty(b.difficulty);
          const job = startJob("chapter", { workId, chapterId, targets: [target], difficulties: [level] });
          job.total = 1;
          runJob(job, async () => {
            const r = await translateChapter(store, { workId, chapterId, target, difficulty: level, force: !!b.force });
            job.done = 1;
            job.current = `${target} (${level})`;
            return { cached: r.cached, chunks: r.chunks, provider: r.provider, qa: r.qa, difficulty: r.difficulty };
          });
          return json(res, 202, { jobId: job.id, workId, chapterId, target, difficulty: level });
        }
        if (seg[5] === "versions" && seg[6] && seg[7] === "restore" && method === "POST") {
          return json(res, 200, await restoreVersion(store, { workId, chapterId, hash: decodeURIComponent(seg[6]) }));
        }
      }
    }

    if (method === "GET" || method === "HEAD") return serveStatic(req, res);
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

async function shutdown(signal) {
  console.log(`${signal} received — flushing library…`);
  try { await store.close(); console.log("library flushed"); } catch (e) { console.error("flush failed:", e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log(`LN Translator: http://localhost:${PORT}`);
  console.log(`Storage: ${store.describe()}`);
  const models = [process.env.GROQ_API_KEY && `groq/${PRIMARY.model} (primary)`, process.env.GEMINI_API_KEY && `gemini/${BACKUP.model} (extreme backup)`].filter(Boolean);
  console.log(`Models: ${models.length ? models.join(", ") : "none configured — set GROQ_API_KEY"}`);
});
