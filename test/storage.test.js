import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, LocalBackend, GitHubBackend } from "../src/store.js";
import { S3Client } from "../src/s3.js";

let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), "ln-store-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("local backend store", () => {
  it("persists db, texts, terms and tm across instances", async () => {
    const store = new Store(new LocalBackend(dir), { debounceMs: 1 });
    await store.load();
    await store.update((db) => { db.works.w1 = { id: "w1", title: "T" }; });
    const hash = await store.saveText("hello world");
    store.saveTerms("w1", { A: { source: "A", langs: { en: { canonical: "AA", variants: [] } } } });
    store.saveTm("w1", "en", { abc: { text: "translated" } });
    assert.equal(await store.flush() >= 3, true); // db.json + terms + tm (+ maybe texts index)

    const fresh = new Store(new LocalBackend(dir), { debounceMs: 1 });
    await fresh.load();
    assert.equal(fresh.db.works.w1.title, "T");
    assert.equal(await fresh.loadText(hash), "hello world");
    assert.equal((await fresh.loadTerms("w1")).A.langs.en.canonical, "AA");
    assert.equal((await fresh.loadTm("w1", "en")).abc.text, "translated");
  });

  it("stores each text blob once (hash dedupe)", async () => {
    const store = new Store(new LocalBackend(dir), { debounceMs: 1 });
    const a = await store.saveText("same content");
    const keys = await new LocalBackend(dir).listKeys("texts/");
    const b = await store.saveText("same content");
    assert.equal(a, b);
    assert.equal(keys.filter((k) => k === `texts/${a}.txt`).length, 1);
  });

  it("exports and re-imports the whole library", async () => {
    const store = new Store(new LocalBackend(dir), { debounceMs: 1 });
    await store.load();
    await store.update((db) => { db.works.w2 = { id: "w2", title: "Second" }; });
    const dump = await store.exportAll();
    assert.equal(dump.format, "ln-translator-export");
    assert.ok(dump.db.works.w2);

    const otherDir = await mkdtemp(path.join(tmpdir(), "ln-store2-"));
    const other = new Store(new LocalBackend(otherDir), { debounceMs: 1 });
    const stats = await other.importAll(dump);
    assert.ok(stats.works >= 1);
    assert.equal((await other.load()).works.w2.title, "Second");
    await rm(otherDir, { recursive: true, force: true });
  });
});

describe("github backend (durable, free)", () => {
  it("reads, writes with sha handling, and retries on a stale sha", async () => {
    const files = new Map(); // path -> {content, sha}
    let puts = 0, conflicts = 0;
    const fetchFn = async (url, opts = {}) => {
      const p = decodeURIComponent(String(url).split("/contents/")[1]?.split("?")[0] || "");
      const accept = opts.headers?.Accept || "";
      if (!opts.method || opts.method === "GET") {
        const f = files.get(p);
        if (accept.includes("raw")) {
          if (!f) return { status: 404, ok: false, headers: { get: () => null }, text: async () => "" };
          return { status: 200, ok: true, headers: { get: () => f.sha }, text: async () => f.content };
        }
        return f
          ? { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ sha: f.sha }) }
          : { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
      }
      // PUT
      puts++;
      const body = JSON.parse(opts.body);
      const current = files.get(p);
      if (current && body.sha && body.sha !== current.sha) {
        conflicts++;
        return { status: 409, ok: false, headers: { get: () => null }, text: async () => "conflict" };
      }
      const content = Buffer.from(body.content, "base64").toString("utf8");
      const sha = "sha-" + (puts);
      files.set(p, { content, sha });
      return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ content: { sha } }) };
    };

    const backend = new GitHubBackend({ repo: "me/data", token: "t", fetchFn });
    const store = new Store(backend, { debounceMs: 1 });
    await store.load();
    await assert.rejects(() => store.loadText("deadbeef"), /not found/i);

    const hash = await store.saveText("chapter body");
    assert.equal(await backend.getText(`texts/${hash}.txt`), "chapter body");
    await store.update((db) => { db.works.w = { id: "w", title: "From GitHub" }; });
    await store.flush();
    assert.ok(files.has("db.json"));

    // stale sha path: forget the cached sha, write again → backend must refetch and succeed
    backend.shas.clear();
    await backend.putText("db.json", JSON.stringify({ hello: "again" }));
    assert.equal(JSON.parse(files.get("db.json").content).hello, "again");
    assert.ok(puts >= 2);
    assert.ok(conflicts === 0, "no unresolved conflicts");
  });
});

describe("s3/r2 signing", () => {
  it("signs requests with AWS4-HMAC-SHA256 and signed headers", async () => {
    let captured = null;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, text: async () => "" }; };
    const client = new S3Client({
      endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "SECRET", bucket: "mybucket", fetchFn,
    });
    await client.put("db.json", "{}", "application/json");
    assert.match(captured.url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/mybucket\/db\.json$/);
    const auth = captured.opts.headers.Authorization;
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    assert.match(auth, /SignedHeaders=.*host.*x-amz-content-sha256.*x-amz-date/);
    assert.match(auth, /Signature=[0-9a-f]{64}$/);
    assert.equal(captured.opts.method, "PUT");
  });

  it("returns null for missing keys and parses list pagination", async () => {
    const fetchFn = async (url) => {
      if (String(url).endsWith("/nope")) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, text: async () => "<ListBucketResult><Key>texts/a.txt</Key><Key>texts/b.txt</Key><IsTruncated>false</IsTruncated></ListBucketResult>" };
    };
    const client = new S3Client({ endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: "a", secretAccessKey: "b", bucket: "c", fetchFn });
    assert.equal(await client.get("nope"), null);
    assert.deepEqual(await client.list("texts/"), ["texts/a.txt", "texts/b.txt"]);
    assert.match(await client.get("db.json"), /Key>texts\/a\.txt/);
  });
});
