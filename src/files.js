// File I/O: .txt / .md / .html natively, .epub via jszip (optional dep).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_IN = [".txt", ".md", ".markdown", ".html", ".htm", ".epub", ".pdf"];
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

/** Parse an uploaded file's bytes into novel text (.txt/.md/.html/.epub/.pdf). */
export async function parseBuffer(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".epub") return epubToText(buffer);
  if (ext === ".pdf") return pdfToText(buffer);
  const raw = buffer.toString("utf8");
  if (ext === ".html" || ext === ".htm") return htmlToText(raw);
  return raw.replace(/\r\n?/g, "\n").trim() + "\n";
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

  const out = [];
  for (const lines of pageLines) {
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

  return htmlToText(out.join("").replace(/\n{3,}/g, "\n\n")).trim() + "\n";
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
  return texts.filter(Boolean).join("\n\n") + "\n";
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
