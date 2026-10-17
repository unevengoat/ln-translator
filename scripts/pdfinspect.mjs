import { readFile } from "node:fs/promises";
import { parseBuffer } from "../src/files.js";
import { splitChapters } from "../src/library.js";

const file = "Eminence in Shadow Vol. 1.pdf";
const text = await parseBuffer(file, await readFile(file));
const parts = splitChapters(text);
parts.forEach((p, i) => {
  console.log(`\n--- part ${i}: ${p.title} (${p.text.length} chars) ---`);
  console.log("START:", p.text.slice(0, 220).replace(/\n/g, " ⏎ "));
  console.log("END:  ", p.text.slice(-160).replace(/\n/g, " ⏎ "));
});
console.log("\nraw occurrences of 'Chapter':", (text.match(/Chapter/gi) || []).length);
const idx = [...text.matchAll(/^Chapter\s+\d+/gim)].map((m) => m.index);
console.log("line-start chapter marker positions:", idx.length);
