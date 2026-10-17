import { readFile } from "node:fs/promises";
import { parseBuffer } from "../src/files.js";
import { splitChapters } from "../src/library.js";

for (const n of process.argv.slice(2)) {
  const file = `Eminence in Shadow Vol. ${n}.pdf`;
  const text = await parseBuffer(file, await readFile(file));
  const parts = splitChapters(text);
  console.log(`\n=== Vol ${n}: ${text.length.toLocaleString()} chars, ${parts.length} chapters ===`);
  for (const p of parts) {
    console.log(`  [${String(p.text.length).padStart(6)}] ${p.volume || "-"} | ${p.title || "(untitled)"}`);
  }
}
