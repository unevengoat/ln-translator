// File-backed store (zero dependencies): works, chapters, texts (deduped by
// hash), segment translation memory, per-work terms, chapter translation cache.
// All writes are serialized through a queue so concurrent web users can't
// corrupt the JSON. Reads are lock-free from memory.
//
// NOTE on hosting: Render's free tier has an ephemeral filesystem, so `data/`
// resets on redeploy/restart. Point DATA_DIR at a Render Disk (paid) or swap
// this Store for a Postgres adapter later — library.js only uses the methods
// below, so the seam is small.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const emptyDb = () => ({ works: {}, chapters: {}, tm: {}, terms: {}, translations: {}, seq: 1 });

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.textsDir = path.join(dir, "texts");
    this.db = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.db) return this.db;
    await mkdir(this.textsDir, { recursive: true });
    try {
      this.db = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      this.db = emptyDb();
    }
    return this.db;
  }

  /** Run fn(db) exclusively, then persist. Returns fn's return value. */
  update(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      const out = await fn(this.db);
      const tmp = this.file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.db), "utf8");
      await rename(tmp, this.file);
      return out;
    });
    this.queue = run.catch(() => {}); // keep the queue alive on errors
    return run;
  }

  async read(fn) {
    await this.load();
    return fn(this.db);
  }

  textPath(hash) {
    return path.join(this.textsDir, hash + ".txt");
  }

  async saveText(text) {
    const hash = sha256(text);
    try {
      await readFile(this.textPath(hash), "utf8");
    } catch {
      await mkdir(this.textsDir, { recursive: true });
      await writeFile(this.textPath(hash), text, "utf8");
    }
    return hash;
  }

  loadText(hash) {
    return readFile(this.textPath(hash), "utf8");
  }
}

export function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

let _global = null;
export function globalStore() {
  if (!_global) _global = new Store(dataDir());
  return _global;
}
