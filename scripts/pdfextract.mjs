// Extract text from a PDF (uses the same code path as uploads) and show a sample.
import { readFile, writeFile } from "node:fs/promises";
import { parseBuffer } from "../src/files.js";
import { splitChapters } from "../src/library.js";

const file = process.argv[2];
const buf = await readFile(file);
const t0 = Date.now();
const text = await parseBuffer(file, buf);
console.log(`extracted ${text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("first 600 chars:\n" + text.slice(0, 600));
console.log("\n…middle:\n" + text.slice(Math.floor(text.length / 2), Math.floor(text.length / 2) + 400));
console.log("\nparagraph count:", text.split("\n\n").length);
const parts = splitChapters(text);
console.log("chapter markers detected:", parts.length);
console.log("first 12 titles:", JSON.stringify(parts.slice(0, 12).map((p) => p.title || "(untitled)"), null, 0));
if (process.argv[3]) { await writeFile(process.argv[3], text, "utf8"); console.log("saved to", process.argv[3]); }
