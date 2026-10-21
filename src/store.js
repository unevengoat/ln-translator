// Durable, free-first storage for the shared library.
//
// Backends (auto-selected, first configured wins):
//   1. Cloudflare R2  — 10 GB free, no egress. Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
//                       R2_SECRET_ACCESS_KEY, R2_BUCKET.
//   2. GitHub repo    — free forever, versioned history (Wikipedia-like). Env:
//                       GH_DATA_REPO (owner/name), GH_TOKEN, GH_BRANCH (default main).
//   3. Local disk     — dev fallback (ephemeral on Render free).
//
// Layout in the backend (all small files, so no 1 MB API limit issues):
//   db.json                      works / chapters / translations / settings
//   index/texts.json             list of stored text hashes
//   texts/<hash>.txt             chapter source + chapter translation blobs
//   terms/<workId>.json          per-story term table
//   tm/<workId>__<lang>.json     per-story translation memory
//
// Writes are cached in memory and flushed on a debounce, plus an explicit
// flush() after every meaningful operation, so we stay well inside rate limits.
import { readFile, writeFile, mkdir, rename, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { r2FromEnv } from "./s3.js";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const emptyDb = () => ({ works: {}, chapters: {}, workIndex: {}, translations: {}, activity: [], version: 1 });

/* ------------------------------------------------------------------ backends */

export class LocalBackend {
  name = "local-disk";
  constructor(dir) {
    this.dir = dir;
    this.cacheDir = path.join(dir, "cache");
  }
  _p(p) { return path.join(this.dir, p); }
  async getText(p) {
    try { return await readFile(this._p(p), "utf8"); } catch { return null; }
  }
  async getBuffer(p) {
    try { return await readFile(this._p(p)); } catch { return null; }
  }
  async putText(p, body) {
    const full = this._p(p);
    await mkdir(path.dirname(full), { recursive: true });
    // Unique temp name so concurrent flushes can't clobber each other.
    const tmp = `${full}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, full);
    return true;
  }
  async putBuffer(p, body) {
    const full = this._p(p);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, Buffer.from(body));
    await rename(tmp, full);
    return true;
  }
  async delete(p) {
    try { await unlink(this._p(p)); } catch (e) { if (e.code !== "ENOENT") throw e; }
    return true;
  }
  async listKeys(prefix) {
    const base = this._p(prefix);
    try {
      const entries = await readdir(base, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`);
    } catch { return []; }
  }
  async revision(p) {
    try { const st = await stat(this._p(p)); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
  }
  describe() { return `local disk (${this.dir})`; }
}

export class R2Backend {
  name = "cloudflare-r2";
  constructor(client) { this.client = client; }
  getText(p) { return this.client.get(p); }
  async getBuffer(p) { return this.client.getBuffer(p); }
  putText(p, body) { return this.client.put(p, body, "application/octet-stream"); }
  putBuffer(p, body, contentType) { return this.client.put(p, body, contentType); }
  delete(p) { return this.client.delete(p); }
  listKeys(prefix) { return this.client.list(prefix); }
  async revision(p) { const r = await this.client.head(p).catch(() => null); return r?.etag || null; }
  describe() { return `Cloudflare R2 (${this.client.bucket})`; }
}

export class GitHubBackend {
  name = "github-repo";
  constructor({ repo, token, branch = "main", fetchFn = fetch }) {
    this.repo = repo; this.token = token; this.branch = branch; this.fetchFn = fetchFn; this.shas = new Map();
  }
  _headers(accept) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ln-translator",
    };
  }
  _url(p) { return `https://api.github.com/repos/${this.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}`; }

  async getText(p) {
    const res = await this.fetchFn(this._url(p) + `?ref=${this.branch}`, { headers: this._headers("application/vnd.github.raw") });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${p} → ${res.status}`);
    const etag = res.headers?.get?.("etag");
    if (etag) this.shas.set(p, etag);
    return res.text();
  }

  async getBuffer(p) {
    const res = await this.fetchFn(this._url(p) + `?ref=${this.branch}`, { headers: this._headers("application/vnd.github.raw") });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${p} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async putBuffer(p, body, contentType = "application/octet-stream", message = `update ${p}`) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await this._sha(p);
      const res = await this.fetchFn(this._url(p), {
        method: "PUT",
        headers: { ...this._headers("application/vnd.github+json"), "Content-Type": "application/json" },
        body: JSON.stringify({ message, content: Buffer.from(body).toString("base64"), branch: this.branch, ...(sha ? { sha } : {}) }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.content?.sha) this.shas.set(p, data.content.sha);
        return true;
      }
      if (res.status === 409 || res.status === 422) { this.shas.delete(p); continue; }
      if (res.status === 403 || res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(`GitHub PUT ${p} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    throw new Error(`GitHub PUT ${p} failed after retries`);
  }

  async delete(p) {
    const sha = await this._sha(p);
    if (!sha) return true;
    const res = await this.fetchFn(this._url(p), {
      method: "DELETE", headers: { ...this._headers("application/vnd.github+json"), "Content-Type": "application/json" },
      body: JSON.stringify({ message: `delete ${p}`, sha, branch: this.branch }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub DELETE ${p} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    this.shas.delete(p);
    return true;
  }

  async _sha(p) {
    if (this.shas.has(p)) return this.shas.get(p);
    const res = await this.fetchFn(this._url(p) + `?ref=${this.branch}`, { headers: this._headers("application/vnd.github+json") });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub meta ${p} → ${res.status}`);
    const data = await res.json();
    if (data.sha) this.shas.set(p, data.sha);
    return data.sha || null;
  }

  async putText(p, body, message = `update ${p}`) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await this._sha(p);
      const res = await this.fetchFn(this._url(p), {
        method: "PUT",
        headers: { ...this._headers("application/vnd.github+json"), "Content-Type": "application/json" },
        body: JSON.stringify({ message, content: Buffer.from(body, "utf8").toString("base64"), branch: this.branch, ...(sha ? { sha } : {}) }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.content?.sha) this.shas.set(p, data.content.sha);
        return true;
      }
      if (res.status === 409 || res.status === 422) { this.shas.delete(p); continue; } // stale sha → refetch
      if (res.status === 403 || res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(`GitHub PUT ${p} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    throw new Error(`GitHub PUT ${p} failed after retries`);
  }

  /** GitHub has no cheap listing here, so the store keeps index/texts.json. */
  async listKeys() { return []; }

  /** Fresh (uncached) revision of a file = its blob sha. */
  async revision(p) {
    const res = await this.fetchFn(this._url(p) + `?ref=${this.branch}`, { headers: this._headers("application/vnd.github+json") });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (data.sha) this.shas.set(p, data.sha);
    return data.sha || null;
  }

  /** Token/repo introspection for the health endpoint. */
  async info() {
    try {
      const r = await this.fetchFn(`https://api.github.com/repos/${this.repo}`, { headers: this._headers("application/vnd.github+json") });
      const scopes = r.headers?.get?.("x-oauth-scopes") || "";
      let json = null;
      try { json = await r.json(); } catch { /* ignore */ }
      return {
        provider: "github", repo: this.repo, branch: this.branch, ok: r.ok, status: r.status,
        scopes, private: json?.private ?? null,
        broadToken: /(^|,\s*)repo(,|$)/.test(scopes),
        rateRemaining: r.headers?.get?.("x-ratelimit-remaining") || null,
      };
    } catch (e) {
      return { provider: "github", repo: this.repo, ok: false, error: e.message };
    }
  }

  describe() { return `GitHub repo (${this.repo}@${this.branch})`; }
}

export function createBackend(fetchFn = fetch) {
  const r2 = r2FromEnv(fetchFn);
  if (r2) return new R2Backend(r2);
  if (process.env.GH_DATA_REPO && process.env.GH_TOKEN) {
    return new GitHubBackend({ repo: process.env.GH_DATA_REPO, token: process.env.GH_TOKEN, branch: process.env.GH_BRANCH || "main", fetchFn });
  }
  return new LocalBackend(process.env.DATA_DIR || path.join(process.cwd(), "data"));
}

/* --------------------------------------------------------------------- store */

export class Store {
  constructor(backend, { debounceMs = 20000 } = {}) {
    this.backend = backend;
    this.debounceMs = debounceMs;
    this.db = null;
    this.hashes = new Set();
    this.textCache = new Map();
    this.termsCache = new Map();
    this.tmCache = new Map();
    this.pending = new Map(); // path -> () => string
    this.rawCache = new Map();
    this.timer = null;
    this.queue = Promise.resolve();
  }

  get backendName() { return this.backend.name; }
  describe() { return this.backend.describe(); }

  async load() {
    if (this.db) return this.db;
    const raw = await this.backend.getText("db.json");
    this.db = raw ? { ...emptyDb(), ...JSON.parse(raw) } : emptyDb();
    const idx = await this.backend.getText("index/texts.json").catch(() => null);
    if (idx) { try { this.hashes = new Set(JSON.parse(idx)); } catch { this.hashes = new Set(); } }
    this.dbRev = await this._rev();
    this.lastCheck = Date.now();
    return this.db;
  }

  async _rev(path = "db.json") {
    try { return this.backend.revision ? await this.backend.revision(path) : null; } catch { return null; }
  }

  /**
   * If storage was changed outside this process (a hand edit of db.json, or
   * another instance), reload. Called on reads at most every `minMs`.
   */
  async maybeRefresh(minMs = 120000) {
    if (!this.db) return false;
    const run = this.queue.then(async () => {
      if (!this.db || Date.now() - (this.lastCheck || 0) < minMs) return false;
      // Never reload over unsaved work. Check again on the next read after the
      // pending write has completed.
      if (this.pending.size) return false;
      this.lastCheck = Date.now();
      try {
        const rev = await this._rev();
        if (rev && this.dbRev && rev !== this.dbRev) {
          await this.flush();
          await this._reload();
          return true;
        }
        if (rev) this.dbRev = rev;
      } catch { /* ignore transient revision failures */ }
      return false;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Reload safely after any queued updates; never discard pending local writes. */
  reload() {
    const run = this.queue.then(async () => {
      if (this.pending.size) await this.flush();
      return this._reload();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Drop clean in-memory caches and read everything fresh from storage. */
  async _reload() {
    this.db = null;
    this.hashes = new Set();
    this.termsCache.clear();
    this.tmCache.clear();
    this.rawCache.clear();
    this.dbRev = null;
    return this.load();
  }

  _mark(path, contentFn) {
    this.pending.set(path, contentFn);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.debounceMs);
      this.timer.unref?.();
    }
  }

  /** Persist everything that is pending right now (serialized). */
  async flush() {
    const prev = this.flushChain || Promise.resolve();
    const run = prev.then(() => this._flushOnce());
    this.flushChain = run.catch(() => {});
    return run;
  }

  async _flushOnce() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [p, get] of entries) await this.backend.putText(p, get(), `ln-translator: ${p}`);
    // Remember our own revision so the next staleness check doesn't reload needlessly.
    if (entries.some(([p]) => p === "db.json")) this.dbRev = await this._rev();
    return entries.length;
  }

  update(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      const out = await fn(this.db);
      this._mark("db.json", () => JSON.stringify(this.db));
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async read(fn) { await this.load(); return fn(this.db); }

  /* ---- text blobs ---- */
  async saveText(text) {
    const hash = sha256(text);
    if (!this.hashes.has(hash)) {
      await this.backend.putText(`texts/${hash}.txt`, text, `ln-translator: chapter text ${hash.slice(0, 8)}`);
      this.hashes.add(hash);
      this._mark("index/texts.json", () => JSON.stringify([...this.hashes]));
    }
    this.textCache.set(hash, text);
    return hash;
  }

  async loadText(hash) {
    if (this.textCache.has(hash)) return this.textCache.get(hash);
    const t = await this.backend.getText(`texts/${hash}.txt`);
    if (t == null) throw new Error("Text blob not found: " + hash);
    this.textCache.set(hash, t);
    return t;
  }

  async loadBuffer(path) {
    if (!this.backend.getBuffer) throw new Error(`Binary storage is not supported by ${this.backendName}.`);
    const body = await this.backend.getBuffer(path);
    if (body == null) return null;
    return Buffer.from(body);
  }

  async saveBuffer(path, body, contentType) {
    if (!this.backend.putBuffer) throw new Error(`Binary storage is not supported by ${this.backendName}.`);
    await this.backend.putBuffer(path, body, contentType, `ln-translator: ${path}`);
    return true;
  }

  async deleteFile(path) {
    if (!this.backend.delete) throw new Error(`File deletion is not supported by ${this.backendName}.`);
    return this.backend.delete(path);
  }

  /* ---- per-story terms ---- */
  async loadTerms(workId) {
    if (this.termsCache.has(workId)) return this.termsCache.get(workId);
    const raw = await this.backend.getText(`terms/${workId}.json`).catch(() => null);
    const terms = raw ? JSON.parse(raw) : {};
    this.termsCache.set(workId, terms);
    return terms;
  }

  saveTerms(workId, terms) {
    this.termsCache.set(workId, terms);
    this._mark(`terms/${workId}.json`, () => JSON.stringify(terms));
    return terms;
  }

  /* ---- per-story translation memory (per language AND reading level) ---- */
  async loadTm(workId, lang, difficulty = "medium") {
    const key = `${workId}|${lang}|${difficulty}`;
    if (this.tmCache.has(key)) return this.tmCache.get(key);
    const file = difficulty === "medium" ? `tm/${workId}__${lang}.json` : `tm/${workId}__${lang}__${difficulty}.json`;
    const raw = await this.backend.getText(file).catch(() => null);
    const tm = raw ? JSON.parse(raw) : {};
    this.tmCache.set(key, tm);
    return tm;
  }

  saveTm(workId, lang, tm, difficulty = "medium") {
    const key = `${workId}|${lang}|${difficulty}`;
    this.tmCache.set(key, tm);
    const file = difficulty === "medium" ? `tm/${workId}__${lang}.json` : `tm/${workId}__${lang}__${difficulty}.json`;
    this._mark(file, () => JSON.stringify(tm));
    return tm;
  }

  /* ---- raw JSON files (profiles, per-profile state, anything else) ---- */
  async readRaw(path) {
    if (this.rawCache.has(path)) return this.rawCache.get(path);
    const raw = await this.backend.getText(path);
    if (raw == null) return null;
    this.rawCache.set(path, raw);
    return raw;
  }

  writeRaw(path, obj) {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj);
    this.rawCache.set(path, body);
    this._mark(path, () => body);
    return obj;
  }

  /* ---- backup / migration ---- */
  async exportAll() {
    await this.load();
    await this.flush();
    const texts = {};
    for (const h of this.hashes) texts[h] = await this.loadText(h).catch(() => null);
    const terms = {};
    const tm = {};
    for (const w of Object.values(this.db.works)) {
      terms[w.id] = await this.loadTerms(w.id).catch(() => ({}));
      for (const lang of new Set(w.languages || [])) {
        for (const d of ["medium", "easy", "hard"]) tm[`${w.id}|${lang}|${d}`] = await this.loadTm(w.id, lang, d).catch(() => ({}));
      }
    }
    // illustrations referenced by chapter texts (bounded: big scans stay in live storage)
    let images = { registry: {}, blobs: {}, skipped: 0 };
    try {
      images.registry = db.images || {};
      let bytes = 0;
      const extOf = (ct) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[ct] || "bin");
      for (const [id, meta] of Object.entries(images.registry)) {
        if (bytes > 12_000_000) { images.skipped++; continue; }
        const body = await this.loadBuffer(`images/${id}.${extOf(meta.contentType)}`).catch(() => null);
        if (!body) { images.skipped++; continue; }
        if (body.length > 4_000_000 || bytes + body.length > 15_000_000) { images.skipped++; continue; }
        images.blobs[id] = body.toString("base64");
        bytes += body.length;
      }
    } catch { /* images stay in live storage */ }
    // profiles + their private reading state (so a backup is complete)
    let profiles = null;
    const states = {};
    try {
      const raw = await this.readRaw("profiles.json");
      if (raw) {
        profiles = JSON.parse(raw);
        for (const p of profiles.profiles || []) {
          const s = await this.readRaw(`profiles/${p.id}.json`).catch(() => null);
          if (s) states[p.id] = JSON.parse(s);
        }
      }
    } catch { /* ignore */ }
    return { format: "ln-translator-export", version: 3, exportedAt: Date.now(), backend: this.backendName, db: this.db, texts, terms, tm, profiles, states, images };
  }

  /** Merge an export into this store. Never deletes; newest record wins. */
  async importAll(payload, { fetchFn } = {}) {
    if (!payload || payload.format !== "ln-translator-export") throw new Error("Not an ln-translator export file.");
    await this.load();
    const stats = { works: 0, chapters: 0, translations: 0, texts: 0, terms: 0, tm: 0 };
    await this.update((db) => {
      for (const [workId, work] of Object.entries(payload.db?.works || {})) {
        const existing = db.works[workId];
        if (!existing) { db.works[workId] = work; stats.works++; }
        else if ((work.updatedAt || 0) > (existing.updatedAt || 0)) { db.works[workId] = { ...existing, ...work }; stats.works++; }
      }
      for (const [key, ch] of Object.entries(payload.db?.chapters || {})) {
        if (!db.chapters[key]) { db.chapters[key] = ch; stats.chapters++; }
      }
      for (const [key, tr] of Object.entries(payload.db?.translations || {})) {
        const existing = db.translations[key];
        if (!existing || (tr.at || 0) > (existing.at || 0)) { db.translations[key] = tr; stats.translations++; }
      }
      for (const path of Object.entries(payload.db?.workIndex || {})) db.workIndex[path[0]] = path[1];
    });
    for (const [hash, text] of Object.entries(payload.texts || {})) {
      if (text == null || this.hashes.has(hash)) continue;
      await this.backend.putText(`texts/${hash}.txt`, text, `import text ${hash.slice(0, 8)}`);
      this.hashes.add(hash);
      stats.texts++;
    }
    if (stats.texts) await this.update(() => {}); // schedule index write
    for (const [workId, terms] of Object.entries(payload.terms || {})) {
      const current = await this.loadTerms(workId);
      for (const [source, term] of Object.entries(terms || {})) {
        const ex = current[source];
        if (!ex) { current[source] = term; stats.terms++; }
        else {
          for (const [lang, slot] of Object.entries(term.langs || {})) {
            const cur = ex.langs?.[lang];
            if (!cur) { (ex.langs ||= {})[lang] = slot; stats.terms++; }
            else if (slot.origin === "user" && cur.origin !== "user") { ex.langs[lang] = slot; stats.terms++; }
          }
        }
      }
      this.saveTerms(workId, current);
    }
    for (const [key, tm] of Object.entries(payload.tm || {})) {
      const [workId, lang, difficulty = "medium"] = key.split("|");
      const current = await this.loadTm(workId, lang, difficulty);
      for (const [h, v] of Object.entries(tm || {})) if (!current[h]) { current[h] = v; stats.tm++; }
      this.saveTm(workId, lang, current, difficulty);
    }
    stats.images = 0;
    const imgExtOf = (ct) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[ct] || "bin");
    for (const [id, meta] of Object.entries(payload.images?.registry || {})) {
      const db0 = await this.load();
      if (!db0.images?.[id]) await this.update((db) => { db.images = db.images || {}; db.images[id] = meta; });
      const blob = payload.images?.blobs?.[id];
      if (blob && !(await this.loadBuffer(`images/${id}.${imgExtOf(meta.contentType)}`).catch(() => null))) {
        await this.backend.putBuffer(`images/${id}.${imgExtOf(meta.contentType)}`, Buffer.from(blob, "base64"), meta.contentType || "application/octet-stream", `import image ${id}`).catch(() => null);
        stats.images++;
      }
    }
    await this.flush();
    // profiles (merge by name, keep local PINs)
    if (payload.profiles?.profiles?.length) {
      const mine = JSON.parse((await this.readRaw("profiles.json")) || '{"profiles":[],"tokens":{}}');
      const byName = new Map((mine.profiles || []).map((p) => [p.name.toLowerCase(), p]));
      for (const p of payload.profiles.profiles) {
        if (!byName.has(p.name.toLowerCase())) mine.profiles.push({ ...p, id: p.id });
      }
      this.writeRaw("profiles.json", mine);
      for (const [id, st] of Object.entries(payload.states || {})) {
        const existing = await this.readRaw(`profiles/${id}.json`).catch(() => null);
        if (!existing) this.writeRaw(`profiles/${id}.json`, st);
      }
      await this.flush();
    }
    return stats;
  }

  async close() { await this.flush(); }
}

let _global = null;
export function globalStore() {
  if (!_global) _global = new Store(createBackend());
  return _global;
}
export function setGlobalStore(store) { _global = store; }
