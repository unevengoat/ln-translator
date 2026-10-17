import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";

const file = process.argv[2];
const buf = new Uint8Array(await readFile(file));
const doc = await getDocument({ data: buf, useSystemFonts: true, isEvalSupported: false }).promise;
console.log("pages:", doc.numPages);
let out = "";
let withText = 0;
for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  if (text) withText++;
  out += `\n--- page ${p} (${text.length} chars) ---\n` + text.slice(0, 400);
}
console.log(out.slice(0, 3200));
console.log("\npages with text (first 10):", withText);
