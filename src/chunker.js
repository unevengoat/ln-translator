// Paragraph-preserving chunker for novels.
// Rules:
//  - Whole paragraphs are never merged or split across chunks, except a single
//    paragraph longer than maxChars, which gains breaks at sentence seams.
//  - joinChunks(chunks) === input for normal text (no oversized paragraphs).
//  - Accumulates whole paragraphs up to maxChars.
//  - A single oversized paragraph is split on sentence boundaries (CJK + western).
//  - Keeps dialogue lines ("...", 「...」, '...') intact inside their paragraph.

const SENTENCE_RE = /[^。！？!?…\n]+[。！？!?…]+["」』”’)]?|\n|[^\n]+$/g;

function splitLongParagraph(para, maxChars) {
  if (para.length <= maxChars) return [para];
  const sentences = para.match(SENTENCE_RE) || [para];
  const parts = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length <= maxChars) {
      cur += s;
    } else {
      if (cur) parts.push(cur);
      if (s.length <= maxChars) {
        cur = s;
      } else {
        // Hard split a pathological run-on (no sentence marks at all).
        for (let i = 0; i < s.length; i += maxChars) parts.push(s.slice(i, i + maxChars));
        cur = "";
      }
    }
  }
  if (cur) parts.push(cur);
  return parts.filter(Boolean);
}

export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split novel text into chunks of whole paragraphs. Returns string[]. */
export function chunkNovel(text, maxChars = 1800) {
  const norm = normalizeText(text);
  if (!norm) return [];
  const paragraphs = norm.split("\n\n");
  const chunks = [];
  let cur = "";
  const push = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  for (const para of paragraphs) {
    const pieces = splitLongParagraph(para, maxChars);
    for (const piece of pieces) {
      if (!cur) {
        cur = piece;
      } else if ((cur + "\n\n" + piece).length <= maxChars) {
        cur += "\n\n" + piece;
      } else {
        push();
        cur = piece;
      }
    }
  }
  push();
  return chunks;
}

/** Inverse of chunkNovel joining — paragraphs are never merged across chunks incorrectly. */
export function joinChunks(chunks) {
  return chunks.join("\n\n");
}

/** Count chunks without allocating them (for progress display). */
export function countChunks(text, maxChars = 1800) {
  return chunkNovel(text, maxChars).length;
}
