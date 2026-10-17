# LN Translator — Light Novel & Web Novel Library

Translate and **keep** light novels / web novels: consistent names across every
chapter, a shared library anyone can read from, and Groq-quality English, Spanish
and Swedish output from Japanese / Korean / Chinese / English originals.

- **Website** — browse the shared library, add chapters, read any language, fix terms.
- **CLI** — batch-translate chapter files.
- **Engines** — **Groq `openai/gpt-oss-120b` primary**, **Gemini `gemini-flash-latest`
  extreme backup**, free keyless MT as the last resort.

## The database (why a story never changes voice)

Everything is one JSON db + text blobs on disk (`src/store.js`, `src/library.js`):

| Layer | Purpose |
|---|---|
| **Works** | One record per story (title + author + URL). Extra chapters and re-uploads always attach to the **same** work. |
| **Chapters** | Never deleted. Same index + new text = a **new version** (old kept). Identical text = recognised as a **duplicate**, not re-added. |
| **Translation memory** | Keyed by chunk text hash, so the same text is **never paid for twice**, and re-uploading a translated chapter is free. |
| **Terms** | Per story, **one canonical form per target language** (キリト → Kirito/Keith). Latin originals are kept as-is; CJK terms take the model's first form; you can override. |
| **Model pin** | Each story keeps the model that translated it, so its voice stays stable. A different model is only chosen when the pinned one is **retired**. |

**Corrections propagate.** Rename a term once and every saved chapter in that
language *and* the memory are rewritten — no re-translation, and the old form can
never come back:

```
Updated "Keith" in 1 saved translation(s) and 1 memory segment(s). No re-translation needed.
```

## Model policy (Groq first, Gemini as extreme backup)

`src/engines/models.js`:

1. Try the story's **pinned** model, then **Groq `openai/gpt-oss-120b`**.
2. If it returns 404/410 ("model retired"), probe the account's live model list and
   retry the best current chat model (e.g. `qwen/qwen3.8-27b`).
3. Only then fall back to **Gemini `gemini-flash-latest`**.
4. If both are unavailable, an in-library chapter translation **fails loudly and asks
   for a fresh key** rather than silently changing the story's voice. `strict:false`
   opts into keyless free MT instead.

Re-run `node scripts/probe.mjs` any time to see which models each key can use today.

## Getting free keys

- **Groq** (default): console.groq.com → API keys.
- **Gemini** (backup): Google AI Studio → use `gemini-flash-latest`.
- Never paste keys into chat or code. Set them as env vars (local `.env`, Render Environment).

## Run locally

```bash
npm install                 # only jszip (for .epub)
GROQ_API_KEY=... GEMINI_API_KEY=... npm start
# → http://localhost:3000
```

Web app: **Library** (browse/read), **Add chapter** (paste/upload, pick languages to
auto-translate), **Quick translate** (one-off text).

## CLI (batch chapter files)

```bash
# Auto chain (Groq → Gemini → free MT), uses env keys
node src/cli.js --in ch1.txt --from ja --to en --engine ai
# Pin a provider / target
node src/cli.js --in ch1.txt --from ja --to sv --engine ai --provider groq
node src/cli.js --in ch1.txt --from zh-CN --to es --engine ai --provider gemini
# Pure keyless MT
node src/cli.js --in ch1.txt --to en --engine free --glossary samples/glossary.txt
```

Inputs `.txt .md .html .epub`; output `<input>.<target>.<ext>`.

## API (for a website / other clients)

```
GET  /api/languages            GET  /api/providers         GET  /api/stats
GET  /api/works?q=             POST /api/works             GET /api/works/:id
GET  /api/works/:id/chapters/:chapterId?lang=sv
POST /api/works/:id/chapters/:chapterId/translate   { target, force }
GET  /api/works/:id/terms?lang=sv
POST /api/works/:id/terms                            { lang, source, canonical }
POST /api/translate                                  { text, source, target, engine }
```

Upload and translate in one call:

```bash
curl -X POST localhost:3000/api/works -H 'Content-Type: application/json' -d '{
  "title":"Mushoku Tensei","author":"Rifujin na Magonote","sourceLang":"ja",
  "chapterTitle":"Chapter 1","text":"...","autoTranslateTo":["en","es","sv"]}'
```

## Deploy on Render

1. Push to GitHub (this repo). `render.yaml` sets build/start/health-check.
2. Render Dashboard → **New → Web Service** → pick the repo → add env vars
   `GROQ_API_KEY`, `GEMINI_API_KEY`.
3. **Persistence:** the free plan's filesystem is ephemeral, so `DATA_DIR` resets on
   redeploy/restart. For an always-on shared library, add a **Render Disk** and set
   `DATA_DIR=/var/data` (the `disk:` block in `render.yaml` is ready — uncomment it,
   which requires a paid instance type). Until then it's a working demo library that
   resets on deploy.

## Languages

Source: Japanese, Korean, Chinese (Simplified/Traditional), English + auto-detect.
Targets: **English, Spanish, Swedish** are the focus and are tested end-to-end;
31 languages total (see `src/languages.js`).

## Tests

```bash
npm test     # 41 tests, no network (models are stubbed)
```
