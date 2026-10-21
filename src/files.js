// File I/O: .txt / .md / .html natively, .epub via jszip (optional dep).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanNovelArtifacts } from "./qa.js";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const SUPPORTED_IN = [".txt", ".md", ".markdown", ".html", ".htm", ".epub", ".pdf", ".docx", ".odt", ".rtf", ".fb2", ".zip"];
export const SUPPORTED_OUT = [".txt", ".md", ".html"];


function htmlToText(html) {
  return String(html)
    .replace(/<(br|p|div|h[1-6]|li|tr)\b[^>]*>/gi, "\n\n")
    .replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/li>|<\/tr>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return parseBuffer(path.basename(filePath), await readFile(filePath));
}

/** Parse an uploaded file's bytes into novel text. Supports the formats people
 *  actually have novels in: txt, md, html, epub, pdf, docx, odt, rtf, fb2 and
 *  zip archives of any of those. */
export async function parseBuffer(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".epub") return epubToText(buffer);
  if (ext === ".pdf") return cleanNovelArtifacts(await pdfToText(buffer)).trim() + "\n";
  if (ext === ".docx" || ext === ".odt") return officeToText(buffer, ext);
  if (ext === ".zip") return zipToText(buffer, name);
  const raw = buffer.toString("utf8");
  if (ext === ".rtf") return cleanNovelArtifacts(rtfToText(raw)).trim() + "\n";
  if (ext === ".fb2") return cleanNovelArtifacts(fb2ToText(raw)).trim() + "\n";
  if (ext === ".html" || ext === ".htm") return cleanNovelArtifacts(htmlToText(raw)).trim() + "\n";
  return cleanNovelArtifacts(raw.replace(/\r\n?/g, "\n").trim()) + "\n";
}

const decodeEntities = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

/** .docx / .odt — both are zip archives with an XML document inside. */
async function officeToText(buffer, ext) {
  let JSZip;
  try { ({ default: JSZip } = await import("jszip")); }
  catch { throw new Error("Office support needs 'jszip' — run: npm install"); }
  const zip = await JSZip.loadAsync(buffer);
  const target = ext === ".docx" ? "word/document.xml" : "content.xml";
  const entry = zip.file(target) || Object.values(zip.files).find((f) => f.name.endsWith(target.split("/").pop() || target));
  if (!entry) throw new Error(`Could not find ${target} inside the file.`);
  let xml = await entry.async("string");
  // paragraph / line breaks → text breaks, then strip every tag
  xml = xml
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n\n")
    .replace(/<text:p[^>]*>/g, "")
    .replace(/<\/text:p>/g, "\n\n")
    .replace(/<text:line-break[^>]*\/>/g, "\n")
    .replace(/<\/text:h>/g, "\n\n")
    .replace(/<[^>]+>/g, "");
  return cleanNovelArtifacts(decodeEntities(xml).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()) + "\n";
}

/** .rtf — strip control words/groups into plain text. */
function rtfToText(raw) {
  let s = String(raw);
  s = s.replace(/\{\\fonttbl[\s\S]*?\}\}/g, "").replace(/\{\\colortbl[\s\S]*?\}/g, "").replace(/\{\\stylesheet[\s\S]*?\}\}/g, "");
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\(par|line|sect|page)\b\s?/gi, "\n\n").replace(/\\tab\b\s?/gi, "\t");
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_, d) => String.fromCodePoint(((Number(d) + 65536) % 65536)));
  s = s.replace(/\\[a-z]+(-?\d+)?\s?/gi, "").replace(/[{}]/g, "");
  return cleanNovelArtifacts(s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()) + "\n";
}

/** .fb2 — FictionBook XML. */
function fb2ToText(raw) {
  let s = String(raw);
  const body = s.match(/<body[\s\S]*?<\/body>/i);
  s = body ? body[0] : s;
  s = s
    .replace(/<title>\s*<p>([\s\S]*?)<\/p>\s*<\/title>/gi, "\n\n$1\n\n")
    .replace(/<empty-line\s*\/>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
  return cleanNovelArtifacts(decodeEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()) + "\n";
}

/** .zip — a bundle of chapters/files: parse each entry and keep them in order. */
async function zipToText(buffer, name) {
  let JSZip;
  try { ({ default: JSZip } = await import("jszip")); }
  catch { throw new Error("ZIP support needs 'jszip' — run: npm install"); }
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && SUPPORTED_IN.includes(path.extname(f.name).toLowerCase()) && path.extname(f.name).toLowerCase() !== ".zip")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (!entries.length) throw new Error("No readable files inside the zip (txt, md, html, epub, pdf, docx, rtf, fb2).");
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const text = await parseBuffer(f.name, Buffer.from(await f.async("uint8array")));
    const label = path.basename(f.name).replace(/\.[a-z0-9]+$/i, "");
    const looksLikeChapter = /^\s*(chapter|ch\.?|第\s*\d+\s*[章話话節节回]|vol(ume)?\.?\s*\d+)/i.test(label);
    parts.push(`${looksLikeChapter ? "" : `Chapter ${i + 1} — `}${label}\n\n${text.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * PDF → text. Groups text items into lines by their y position, turns bigger
 * vertical gaps into paragraph breaks, and drops running headers/footers
 * (page numbers and lines repeated on most pages).
 */
async function pdfToText(buf) {
  let getDocument;
  try {
    ({ getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
  } catch {
    throw new Error("PDF support needs 'pdfjs-dist' — run: npm install");
  }
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pageLines = [];
  const lineGaps = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      let key = null;
      for (const k of byY.keys()) if (Math.abs(k - y) <= 2) { key = k; break; }
      if (key == null) { key = y; byY.set(key, []); }
      byY.get(key).push({ x: it.transform[4], s: it.str });
    }
    const lines = [...byY.entries()]
      .sort((a, b) => b[0] - a[0]) // top → bottom
      .map(([y, parts]) => ({ y, text: parts.sort((a, b) => a.x - b.x).map((q) => q.s).join("").replace(/\s+/g, " ").trim() }))
      .filter((l) => l.text);
    pageLines.push(lines);
    for (let i = 1; i < lines.length; i++) lineGaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  }

  lineGaps.sort((a, b) => a - b);
  const typical = lineGaps[Math.floor(lineGaps.length * 0.5)] || 12;
  const paraGap = typical * 1.4;

  // Repeated lines (headers/footers): the first/last line of most pages.
  const firstCounts = new Map(), lastCounts = new Map();
  for (const lines of pageLines) {
    if (!lines.length) continue;
    const f = lines[0].text, l = lines[lines.length - 1].text;
    firstCounts.set(f, (firstCounts.get(f) || 0) + 1);
    if (l !== f) lastCounts.set(l, (lastCounts.get(l) || 0) + 1);
  }
  const pagesWithText = pageLines.filter((l) => l.length).length || 1;
  const isRunning = (t, counts) => (counts.get(t) || 0) / pagesWithText > 0.4 || /^\s*[\divxlcdm]{1,5}\s*$/i.test(t);

  // Watermark / spam domains repeated on most pages (e.g. "Page 18some-site.com").
  const domainCounts = new Map();
  for (const lines of pageLines) {
    for (const l of lines) {
      for (const m of l.text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|me|co|ru|xyz|to)\b/gi)) {
        domainCounts.set(m[0], (domainCounts.get(m[0]) || 0) + 1);
      }
    }
  }
  const spam = [...domainCounts].filter(([, c]) => c / pagesWithText > 0.25).map(([d]) => d);
  const spamRe = spam.length ? new RegExp(`(?:Page\\s*\\d+\\s*)?(?:${spam.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi") : null;
  const cleanLine = (t) => {
    let out = t;
    if (spamRe) out = out.replace(spamRe, "");
    return out.replace(/\s{2,}/g, " ").trim();
  };

  const out = [];
  for (const rawLines of pageLines) {
    const lines = rawLines.map((l) => ({ y: l.y, text: cleanLine(l.text) })).filter((l) => l.text);
    if (!lines.length) continue;
    const body = lines.filter((l, i) => !(i === 0 ? isRunning(l.text, firstCounts) : i === lines.length - 1 ? isRunning(l.text, lastCounts) : false));
    const use = body.length ? body : lines;
    let prev = null;
    for (const l of use) {
      if (prev) {
        const gap = Math.abs(prev.y - l.y);
        const needsBreak = gap > paraGap || /[.!?”"’»]$/.test(prev.text);
        out.push(needsBreak ? "\n\n" : "\n");
      }
      out.push(l.text);
      prev = l;
    }
    out.push("\n\n"); // page boundary = paragraph boundary
  }

  return cleanNovelArtifacts(htmlToText(out.join("").replace(/\n{3,}/g, "\n\n")).trim()) + "\n";
}

async function epubToText(buf) {
  let JSZip;
  try {
    ({ default: JSZip } = await import("jszip"));
  } catch {
    throw new Error("EPUB support needs the 'jszip' dependency — run: npm install");
  }
  const zip = await JSZip.loadAsync(buf);
  const opfPath = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith(".opf"));
  if (!opfPath) throw new Error("Invalid EPUB: no .opf found");
  const opf = await zip.files[opfPath].async("string");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const hrefs = [...opf.matchAll(/<item[^>]*href="([^"]+)"[^>]*media-type="application\/xhtml\+xml"/gi)].map((m) =>
    decodeURIComponent(m[1])
  );
  const spine = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/gi)].map((m) => m[1]);
  const idToHref = new Map(
    [...opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/gi)].map((m) => [m[1], decodeURIComponent(m[2])])
  );
  const ordered = (spine.length ? spine.map((id) => idToHref.get(id)) : hrefs)
    .filter(Boolean)
    .map((h) => dir + h.split("#")[0]);
  const texts = [];
  for (const name of ordered) {
    const f = zip.files[name];
    if (!f) continue;
    texts.push(htmlToText(await f.async("string")));
  }
  return cleanNovelArtifacts(texts.filter(Boolean).join("\n\n")) + "\n";
}

/* ------------------------------------------------- illustrations (images) */

/** Paragraph marker that carries an extracted illustration through the pipeline. */
export const imageMarker = (id) => `[[img:${id}]]`;
export const IMAGE_MARKER_RE = /\[\[img:([0-9a-f]{12})\]\]/g;

/** All illustration ids referenced by a text (in order, deduplicated). */
export function extractImageIds(text) {
  const ids = [];
  for (const m of String(text || "").matchAll(IMAGE_MARKER_RE)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

const imageId = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const extFor = (contentType) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[contentType] || "bin");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Minimal PNG encoder (no dependency): 8-bit RGB or RGBA. */
export function encodePng(width, height, rgba, hasAlpha) {
  const channels = hasAlpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = hasAlpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Normalize a pdfjs-decoded image to PNG. Returns null when undecodable. */
export function pdfImageToPng(img) {
  try {
    const w = img.width | 0, h = img.height | 0;
    if (!w || !h || w > 4000 || h > 4000) return null;
    const data = img.data;
    if (!data?.length) return null;
    let rgba, alpha;
    if (data.length === w * h * 4) { rgba = data; alpha = true; }
    else if (data.length === w * h * 3) { rgba = data; alpha = false; }
    else if (data.length === w * h) {
      rgba = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) rgba[i * 3] = rgba[i * 3 + 1] = rgba[i * 3 + 2] = data[i];
      alpha = false;
    } else if (data.length === Math.ceil((w * h) / 8)) {
      rgba = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        const v = (data[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0;
        rgba[i * 3] = rgba[i * 3 + 1] = rgba[i * 3 + 2] = v;
      }
      alpha = false;
    } else return null;
    return { width: w, height: h, png: encodePng(w, h, rgba, alpha) };
  } catch { return null; }
}

/**
 * Parse a file into novel text PLUS its illustrations.
 * Images become `[[img:<id>]]` paragraphs in reading order; the raw bytes
 * come back in `images` for the caller to persist with the store.
 */
export async function parseBufferWithImages(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".epub") return epubWithImages(buffer);
  if (ext === ".pdf") return pdfToTextWithImages(buffer);
  if (ext === ".docx" || ext === ".odt") return officeWithImages(buffer, ext);
  if (ext === ".zip") return zipWithImages(buffer, name);
  if (ext === ".fb2") return fb2WithImages(buffer.toString("utf8"));
  if (ext === ".html" || ext === ".htm") return htmlWithImages(buffer.toString("utf8"));
  return { text: await parseBuffer(name, buffer), images: [] };
}

function collectImage(bytes, contentType, name, images) {
  if (!bytes?.length) return null;
  const id = imageId(bytes);
  if (!images.some((im) => im.id === id)) images.push({ id, name: name || `image.${extFor(contentType)}`, contentType, data: Buffer.from(bytes) });
  return id;
}

function htmlWithImages(raw) {
  const images = [];
  const withMarkers = String(raw).replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src\s*=\s*"([^"]+)"/.exec(tag)?.[1] || /src\s*=\s*'([^']+)'/.exec(tag)?.[1] || "";
    const dm = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(src.trim());
    if (!dm) return "\n\n";
    const data = Buffer.from(dm[2].replace(/\s+/g, ""), "base64");
    const id = collectImage(data, dm[1], "illustration", images);
    return id ? `\n\n${imageMarker(id)}\n\n` : "\n\n";
  });
  return { text: cleanNovelArtifacts(htmlToText(withMarkers)).trim() + "\n", images };
}

function fb2WithImages(raw) {
  const images = [];
  const binaries = new Map();
  for (const m of String(raw).matchAll(/<binary\b[^>]*id="([^"]+)"[^>]*content-type="([^"]+)"[^>]*>([\s\S]*?)<\/binary>/gi)) {
    binaries.set(m[1], { contentType: m[2], data: Buffer.from(m[3].replace(/\s+/g, ""), "base64") });
  }
  let s = String(raw);
  // Cover/frontispiece art lives in <description> (outside <body>) — it is the
  // book's first page, so its markers go first.
  const coverIds = [];
  const desc = s.match(/<description>[\s\S]*?<\/description>/i)?.[0] || "";
  for (const m of desc.matchAll(/<image\b[^>]*?(?:xlink:href|href)="#?([^"]+)"[^>]*\/?>/gi)) {
    if (!coverIds.includes(m[1])) coverIds.push(m[1]);
  }
  const coverMarkers = [];
  for (const cid of coverIds) {
    const cb = binaries.get(cid);
    if (!cb) continue;
    const cImgId = collectImage(cb.data, cb.contentType, cid, images);
    if (cImgId) coverMarkers.push(imageMarker(cImgId));
  }
  const body = s.match(/<body[\s\S]*?<\/body>/i);
  s = body ? body[0] : s;
  s = (coverMarkers.length ? coverMarkers.join("\n\n") + "\n\n" : "") + s
    .replace(/<title>\s*<p>([\s\S]*?)<\/p>\s*<\/title>/gi, "\n\n$1\n\n")
    .replace(/<empty-line\s*\/>/gi, "\n")
    .replace(/<image\b[^>]*?(?:xlink:href|href)="#?([^"]+)"[^>]*\/?>/gi, (_, id) => {
      const b = binaries.get(id);
      if (!b) return "\n\n";
      const imgId = collectImage(b.data, b.contentType, id, images);
      return imgId ? `\n\n${imageMarker(imgId)}\n\n` : "\n\n";
    })
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
  return { text: cleanNovelArtifacts(decodeEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()) + "\n", images };
}

async function officeWithImages(buffer, ext) {
  let JSZip;
  try { ({ default: JSZip } = await import("jszip")); }
  catch { throw new Error("Office support needs 'jszip' — run: npm install"); }
  const images = [];
  const zip = await JSZip.loadAsync(buffer);
  const read = async (n) => { const f = zip.file(n); return f ? Buffer.from(await f.async("uint8array")) : null; };
  const guessType = (n) => /\.png$/i.test(n || "") ? "image/png" : /\.(jpe?g)$/i.test(n || "") ? "image/jpeg" : /\.gif$/i.test(n || "") ? "image/gif" : /\.webp$/i.test(n || "") ? "image/webp" : "image/png";
  if (ext === ".docx") {
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("Could not find word/document.xml inside the file.");
    const docXml = await entry.async("string");
    const relsFile = zip.file("word/_rels/document.xml.rels");
    const rels = relsFile ? await relsFile.async("string").catch(() => "") : "";
    const relMap = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/gi)].map((m) => [m[1], m[2]]));
    const order = [...docXml.matchAll(/<w:drawing[\s\S]*?r:embed="([^"]+)"[\s\S]*?<\/w:drawing>/gi)].map((m) => m[1]);
    const mediaCache = new Map();
    for (const rid of order) {
      const target = relMap.get(rid);
      // Absolute targets ("/word/media/...") are package-rooted; relative ones
      // ("media/...") resolve against word/.
      const zipPath = target && (target.startsWith("/") ? target.replace(/^\/+/, "") : `word/${target.replace(/^\/+/, "")}`);
      if (target && !mediaCache.has(target)) mediaCache.set(target, await read(zipPath));
    }
    let idx = 0;
    let xml = docXml.replace(/<w:drawing[\s\S]*?<\/w:drawing>/gi, () => {
      const rid = order[idx++];
      const target = rid && relMap.get(rid);
      const data = target && mediaCache.get(target);
      if (!data) return "\n\n";
      const imgId = collectImage(data, guessType(target), target.split("/").pop(), images);
      return imgId ? `\n\n${imageMarker(imgId)}\n\n` : "\n\n";
    });
    xml = xml.replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n\n").replace(/<[^>]+>/g, "");
    return { text: cleanNovelArtifacts(decodeEntities(xml).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()) + "\n", images };
  }
  const entry = zip.file("content.xml");
  if (!entry) throw new Error("Could not find content.xml inside the file.");
  let xml = await entry.async("string");
  xml = xml.replace(/<draw:frame[^>]*>([\s\S]*?)<\/draw:frame>/gi, (frame) => {
    const href = /xlink:href="([^"]+)"/.exec(frame)?.[1] || "";
    return `\n\n__ODTIMG__${href}__\/ODTIMG__\n\n`;
  });
  const parts = xml.split(/__ODTIMG__(.*?)__\/ODTIMG__/g);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += parts[i]; continue; }
    const data = parts[i] ? await read(decodeURIComponent(parts[i])) : null;
    const imgId = data ? collectImage(data, guessType(parts[i]), (parts[i] || "").split("/").pop(), images) : null;
    out += imgId ? `\n\n${imageMarker(imgId)}\n\n` : "\n\n";
  }
  out = out.replace(/<text:p[^>]*>/g, "").replace(/<\/text:p>/g, "\n\n").replace(/<text:line-break[^>]*\/>/g, "\n").replace(/<\/text:h>/g, "\n\n").replace(/<[^>]+>/g, "");
  return { text: cleanNovelArtifacts(decodeEntities(out).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()) + "\n", images };
}

async function epubWithImages(buf) {
  let JSZip;
  try { ({ default: JSZip } = await import("jszip")); }
  catch { throw new Error("EPUB support needs the 'jszip' dependency — run: npm install"); }
  const images = [];
  const zip = await JSZip.loadAsync(buf);
  const opfPath = Object.keys(zip.files).find((f) => f.toLowerCase().endsWith(".opf"));
  if (!opfPath) throw new Error("Invalid EPUB: no .opf found");
  const opf = await zip.files[opfPath].async("string");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const byHref = new Map();
  for (const m of opf.matchAll(/<item[^>]*href="([^"]+)"[^>]*media-type="(image\/[^"\s]+)"[^>]*>/gi)) {
    const href = decodeURIComponent(m[1]).split("#")[0];
    const imgEntry = zip.file(dir + href);
    if (!imgEntry) continue;
    const data = await imgEntry.async("uint8array").catch(() => null);
    if (data) byHref.set(href.toLowerCase(), { href, contentType: m[2], data: Buffer.from(data) });
  }
  const hrefs = [...opf.matchAll(/<item[^>]*href="([^"]+)"[^>]*media-type="application\/xhtml\+xml"/gi)].map((m) => decodeURIComponent(m[1]));
  const spine = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/gi)].map((m) => m[1]);
  const idToHref = new Map([...opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/gi)].map((m) => [m[1], decodeURIComponent(m[2])]));
  const ordered = (spine.length ? spine.map((id) => idToHref.get(id)) : hrefs).filter(Boolean).map((h) => dir + h.split("#")[0]);
  const texts = [];
  for (const name of ordered) {
    const f = zip.files[name];
    if (!f) continue;
    let html = await f.async("string");
    const base = name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : dir;
    html = html.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /src\s*=\s*"([^"]+)"/.exec(tag)?.[1] || /src\s*=\s*'([^']+)'/.exec(tag)?.[1] || "";
      const dm = /^data:(image\/[^;]+);base64,([\s\S]+)$/.exec(src.trim());
      if (dm) {
        const data = Buffer.from(dm[2].replace(/\s+/g, ""), "base64");
        const imgId = collectImage(data, dm[1], "illustration", images);
        return imgId ? `\n\n${imageMarker(imgId)}\n\n` : "\n\n";
      }
      const key = decodeURIComponent(src.split("#")[0]).toLowerCase();
      const rel = (key.startsWith("/") ? key.slice(1) : (base + key).replace(/\/[^/]+\/\.\.\//g, "/").replace(/^\.\//, "")).replace(new RegExp(`^${dir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`, "i"), "");
      const hit = byHref.get(rel) || byHref.get(key) || byHref.get(key.split("/").pop());
      if (!hit) return "\n\n";
      const imgId = collectImage(hit.data, hit.contentType, hit.href.split("/").pop(), images);
      return imgId ? `\n\n${imageMarker(imgId)}\n\n` : "\n\n";
    });
    texts.push(htmlToText(html));
  }
  return { text: cleanNovelArtifacts(texts.filter(Boolean).join("\n\n")) + "\n", images };
}

async function zipWithImages(buffer, name) {
  let JSZip;
  try { ({ default: JSZip } = await import("jszip")); }
  catch { throw new Error("ZIP support needs 'jszip' — run: npm install"); }
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && SUPPORTED_IN.includes(path.extname(f.name).toLowerCase()) && path.extname(f.name).toLowerCase() !== ".zip")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (!entries.length) throw new Error("No readable files inside the zip (txt, md, html, epub, pdf, docx, rtf, fb2).");
  const images = [];
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i];
    const r = await parseBufferWithImages(f.name, Buffer.from(await f.async("uint8array")));
    for (const im of r.images) if (!images.some((x) => x.id === im.id)) images.push(im);
    const label = path.basename(f.name).replace(/\.[a-z0-9]+$/i, "");
    const looksLikeChapter = /^\s*(chapter|ch\.?|第\s*\d+\s*[章話话節节回]|vol(ume)?\.?\s*\d+)/i.test(label);
    parts.push(`${looksLikeChapter ? "" : `Chapter ${i + 1} — `}${label}\n\n${r.text.trim()}`);
  }
  return { text: parts.join("\n\n"), images };
}

async function pdfToTextWithImages(buf) {
  let getDocument, OPS;
  try {
    ({ getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
  } catch {
    throw new Error("PDF support needs 'pdfjs-dist' — run: npm install");
  }
  const images = [];
  const imageCache = new Map();
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pageLines = [];
  const lineGaps = [];
  const pageImageMarkers = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      let key = null;
      for (const k of byY.keys()) if (Math.abs(k - y) <= 2) { key = k; break; }
      if (key == null) { key = y; byY.set(key, []); }
      byY.get(key).push({ x: it.transform[4], s: it.str });
    }
    const lines = [...byY.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, parts]) => ({ y, text: parts.sort((a, b) => a.x - b.x).map((q) => q.s).join("").replace(/\s+/g, " ").trim() }))
      .filter((l) => l.text);
    pageLines.push(lines);
    for (let i = 1; i < lines.length; i++) lineGaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    const markers = [];
    try {
      const ops = await page.getOperatorList();
      let count = 0;
      for (let i = 0; i < ops.fnArray.length && images.length < 80 && count < 10; i++) {
        const fn = ops.fnArray[i];
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintInlineImageXObject) continue;
        const ref = ops.argsArray[i]?.[0];
        let raw = null;
        if (ref && typeof ref === "object" && Number.isInteger(ref.width) && ref.data) raw = ref;
        else if (typeof ref === "string") {
          // Painted images live in commonObjs; page.objs only holds fonts etc.
          for (const pool of [page.commonObjs, page.objs]) {
            if (!pool || raw) break;
            try {
              const got = pool.get(ref);
              const v = got && typeof got.then === "function" ? await got : got;
              if (v && Number.isInteger(v.width) && v.data) { raw = v; break; }
            } catch { /* fall through to the callback form below */ }
            try {
              const v = await new Promise((resolve) => {
                let done = false;
                const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 2500);
                pool.get(ref, (val) => { if (!done) { done = true; clearTimeout(to); resolve(val); } });
              });
              if (v && Number.isInteger(v.width) && v.data) { raw = v; break; }
            } catch { /* try the next pool */ }
          }
        }
        if (!raw || !Number.isInteger(raw.width) || !raw.data) continue;
        if (raw.width < 48 || raw.height < 48) continue;
        const decoded = pdfImageToPng(raw);
        if (!decoded) continue;
        count++;
        const key = `${decoded.width}x${decoded.height}:${createHash("sha256").update(decoded.png).digest("hex").slice(0, 16)}`;
        let id = imageCache.get(key);
        if (!id) {
          id = collectImage(decoded.png, "image/png", `page-${p}-fig-${count}.png`, images);
          imageCache.set(key, id);
        }
        if (id) markers.push(imageMarker(id));
      }
    } catch { /* text still extracts when images fail */ }
    pageImageMarkers.push(markers);
  }

  lineGaps.sort((a, b) => a - b);
  const typical = lineGaps[Math.floor(lineGaps.length * 0.5)] || 12;
  const paraGap = typical * 1.4;
  const firstCounts = new Map(), lastCounts = new Map();
  for (const lines of pageLines) {
    if (!lines.length) continue;
    const f = lines[0].text, l = lines[lines.length - 1].text;
    firstCounts.set(f, (firstCounts.get(f) || 0) + 1);
    if (l !== f) lastCounts.set(l, (lastCounts.get(l) || 0) + 1);
  }
  const pagesWithText = pageLines.filter((l) => l.length).length || 1;
  const isRunning = (t, counts) => (counts.get(t) || 0) / pagesWithText > 0.4 || /^\s*[\divxlcdm]{1,5}\s*$/i.test(t);
  const domainCounts = new Map();
  for (const lines of pageLines) {
    for (const l of lines) {
      for (const m of l.text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|me|co|ru|xyz|to)\b/gi)) {
        domainCounts.set(m[0], (domainCounts.get(m[0]) || 0) + 1);
      }
    }
  }
  const spam = [...domainCounts].filter(([, c]) => c / pagesWithText > 0.25).map(([d]) => d);
  const spamRe = spam.length ? new RegExp(`(?:Page\\s*\\d+\\s*)?(?:${spam.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi") : null;
  const cleanLine = (t) => {
    let out = t;
    if (spamRe) out = out.replace(spamRe, "");
    return out.replace(/\s{2,}/g, " ").trim();
  };

  const out = [];
  for (let pi = 0; pi < pageLines.length; pi++) {
    const rawLines = pageLines[pi];
    const lines = rawLines.map((l) => ({ y: l.y, text: cleanLine(l.text) })).filter((l) => l.text);
    if (!lines.length && !pageImageMarkers[pi].length) continue;
    const body = lines.filter((l, i) => !(i === 0 ? isRunning(l.text, firstCounts) : i === lines.length - 1 ? isRunning(l.text, lastCounts) : false));
    const use = body.length ? body : lines;
    let prev = null;
    for (const l of use) {
      if (prev) {
        const gap = Math.abs(prev.y - l.y);
        const needsBreak = gap > paraGap || /[.!?”"’»]$/.test(prev.text);
        out.push(needsBreak ? "\n\n" : "\n");
      }
      out.push(l.text);
      prev = l;
    }
    for (const mk of pageImageMarkers[pi]) out.push("\n\n" + mk);
    out.push("\n\n");
  }
  return { text: cleanNovelArtifacts(htmlToText(out.join("").replace(/\n{3,}/g, "\n\n")).trim()) + "\n", images };
}

export function outputPath(inputPath, targetCode) {
  const ext = path.extname(inputPath);
  const base = inputPath.slice(0, -ext.length);
  return `${base}.${targetCode}${ext === ".epub" ? ".txt" : ext}`;
}

export async function writeOutput(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  const body = text.endsWith("\n") ? text : text + "\n";
  if (ext === ".html" || ext === ".htm") {
    const paras = body.split("\n\n").map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
    await writeFile(filePath, `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n${paras}\n</body></html>\n`, "utf8");
  } else {
    await writeFile(filePath, body, "utf8");
  }
  return filePath;
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
