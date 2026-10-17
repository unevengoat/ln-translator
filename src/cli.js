#!/usr/bin/env node
// CLI: batch-translate chapter files. Example:
//   node src/cli.js --in ch1.txt --from ja --to en
//   node src/cli.js --in ch1.txt --from ja --to sv --provider groq --model openai/gpt-oss-120b
//   node src/cli.js --in ./chapters --from zh-CN --to es --keep-honorifics
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { translateText } from "./engines/index.js";
import { parseGlossary } from "./glossary.js";
import { readInput, writeOutput, outputPath, SUPPORTED_IN } from "./files.js";
import { readFile } from "node:fs/promises";

const HELP = `
ln-translate — light novel / web novel translator

Usage:
  node src/cli.js --in <file|dir> [options]

Required:
  --in <path>        Input .txt/.md/.html/.epub file or directory of files
  --to <code>        Target language (en, id, es, fr, ...)

Options:
  --from <code>      Source language (default: auto)
  --out <path>       Output file/dir (default: <input>.<to>.txt next to input)
  --provider <p>     AI provider: groq | gemini | openrouter | mistral | nvidia |
                     pollinations | custom (default: quality chain groq → gemini)
  --chain <list>     Fallback chain, e.g. "groq,cerebras,pollinations"
                     (per-provider keys come from env; optional :model per item)
  --key <key>        AI API key (or <PROVIDER>_API_KEY env)
  --base-url <url>   Override provider base URL
  --model <name>     AI model (default: provider's first free model)
  --glossary <path>  JSON/TXT glossary file ("source=target" per line, or JSON)
  --max-chunk <n>    Max chars per chunk (default: 1800)
  --keep-honorifics  Keep -san/-sama etc. (default: on; use --no-keep-honorifics to drop)
  --formality <f>    match | formal | casual (default: match)
  --help             Show this help
`;

function args(argv) {
  const o = { from: "auto", "max-chunk": "1800", "keep-honorifics": true, formality: "match" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a.startsWith("--no-")) { o[a.slice(5)] = false; continue; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      o[k] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    }
  }
  return o;
}

async function loadGlossary(p) {
  if (!p) return [];
  const raw = await readFile(p, "utf8");
  try {
    const j = JSON.parse(raw);
    return parseGlossary(Array.isArray(j) ? j : j);
  } catch { return parseGlossary(raw); }
}

async function collectInputs(inPath) {
  const st = await stat(inPath);
  if (!st.isDirectory()) return [inPath];
  const entries = await readdir(inPath);
  return entries
    .filter((f) => SUPPORTED_IN.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(inPath, f));
}

async function main() {
  const o = args(process.argv);
  if (o.help || !o.in || !o.to) {
    console.log(HELP);
    process.exit(o.help ? 0 : 1);
  }
  // No provider options = quality chain (groq → gemini) using env keys.
  if (!o.provider && !o.model && !o.key && !o.chain && !o["base-url"]) o.chain = "auto";
  const t0 = Date.now();
  const glossary = await loadGlossary(o.glossary);
  const inputs = await collectInputs(o.in);
  if (!inputs.length) { console.error("No supported input files found."); process.exit(1); }

  let n = 0;
  for (const input of inputs) {
    const out = o.out && inputs.length === 1 ? o.out : o.out && inputs.length > 1
      ? path.join(o.out, path.basename(outputPath(input, o.to)))
      : outputPath(input, o.to);
    process.stdout.write(`[${++n}/${inputs.length}] ${input} -> ${out} ... `);
    const text = await readInput(input);
    const { translation, chunks, provider, attempts } = await translateText(text, {
      source: o.from, target: o.to, engine: "ai",
      maxChunk: parseInt(o["max-chunk"], 10) || 1800,
      keepHonorifics: o["keep-honorifics"] !== false && o["keep-honorifics"] !== "false",
      formality: o.formality,
      glossary,
      ai: { provider: o.provider, baseUrl: o["base-url"], apiKey: o.key, model: o.model },
      chain: o.chain,
      onProgress: ({ done, total }) => process.stdout.write(`\r[${n}/${inputs.length}] chunk ${done}/${total} ... `),
    });
    await writeOutput(out, translation);
    const tried = (attempts || []).filter((a) => !a.ok).map((a) => `${a.provider} (${a.error})`).join("; ");
    console.log(`done (${chunks} chunks, ${translation.length} chars${provider ? ", via " + provider : ""}${tried ? "; fallback, skipped: " + tried : ""})`);
  }
  console.log(`Finished ${inputs.length} file(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
