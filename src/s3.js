// Minimal S3-compatible client (AWS SigV4) — zero dependencies, used for
// Cloudflare R2 durable storage. Supports GET/PUT/DELETE/HEAD/LIST.
import { createHash, createHmac } from "node:crypto";

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { long: iso, short: iso.slice(0, 8) };
}

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export class S3Client {
  constructor({ endpoint, region = "auto", accessKeyId, secretAccessKey, bucket, fetchFn = fetch }) {
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) throw new Error("S3Client needs endpoint, keys and bucket");
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.fetchFn = fetchFn;
    this.host = new URL(this.endpoint).host;
  }

  async request(method, key, { body, query, contentType } = {}) {
    const payload = body == null ? Buffer.alloc(0) : Buffer.from(body);
    const payloadHash = sha256hex(payload);
    const { long, short } = amzDate();
    // Path-style addressing: /<bucket>/<key>
    const canonicalUri = "/" + this.bucket + (key ? "/" + encodeKey(key) : "");
    const qs = query
      ? Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&")
      : "";
    const headers = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": long,
      ...(contentType ? { "content-type": contentType } : {}),
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalRequest = [method, canonicalUri, qs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${short}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", long, scope, sha256hex(canonicalRequest)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac("AWS4" + this.secretAccessKey, short), this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return this.fetchFn(`${this.endpoint}${canonicalUri}${qs ? "?" + qs : ""}`, {
      method,
      headers: { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": long, ...(contentType ? { "content-type": contentType } : {}) },
      body: payload.length ? payload : undefined,
    });
  }

  async put(key, body, contentType) {
    const res = await this.request("PUT", key, { body, contentType });
    if (!res.ok) throw new Error(`R2 PUT ${key} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
  }

  async get(key) {
    const res = await this.request("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key} → ${res.status}`);
    return res.text();
  }

  async exists(key) {
    const res = await this.request("HEAD", key);
    return res.ok;
  }

  async delete(key) {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → ${res.status}`);
    return true;
  }

  /** List keys under a prefix (handles pagination via continuation tokens). */
  async list(prefix = "", limit = 0) {
    const keys = [];
    let token;
    do {
      const query = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
      const res = await this.request("GET", "", { query });
      if (!res.ok) throw new Error(`R2 LIST ${prefix} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] : null;
      if (limit && keys.length >= limit) break;
    } while (token);
    return keys;
  }
}

/** Cloudflare R2 configured? Reads only env vars — never hard-code secrets. */
export function r2FromEnv(fetchFn = fetch) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    accessKeyId,
    secretAccessKey,
    bucket,
    fetchFn,
  });
}
