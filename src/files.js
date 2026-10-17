// File I/O: .txt / .md / .html natively, .epub via jszip (optional dep).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_IN = [".txt", ".md", ".markdown", ".html", ".htm", ".epub"];
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

/** Parse an uploaded file's bytes into novel text (.txt/.md/.html/.epub). */
export async function parseBuffer(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".epub") return epubToText(buffer);
  const raw = buffer.toString("utf8");
  if (ext === ".html" || ext === ".htm") return htmlToText(raw);
  return raw.replace(/\r\n?/g, "\n").trim() + "\n";
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
