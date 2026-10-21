// File I/O: .txt / .md / .html natively, .epub via jszip (optional dep).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanNovelArtifacts } from "./qa.js";

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
