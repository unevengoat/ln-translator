# LN Translator — Light Novel & Web Novel Library

Translate **and keep** light novels / web novels: consistent names across every
chapter, a shared library anyone can read from, and Groq-quality English,
Spanish and Swedish from Japanese / Korean / Chinese / English originals.

- **Live site:** https://ln-translator.onrender.com
- **Storage:** durable and free (GitHub repo, or Cloudflare R2) — survives redeploys
- **Models:** Groq `openai/gpt-oss-120b` primary, Gemini `gemini-flash-latest` extreme backup
- **Tests:** `npm test` → 56 tests, no network needed

## Free, durable storage (fixes "library resets on redeploy")

The library no longer lives on the app container. `src/store.js` auto-selects a
backend, first configured wins:

| Backend | Cost | Env vars | Notes |
|---|---|---|---|
| **GitHub repo** (default, live now) | free forever | `GH_DATA_REPO`, `GH_TOKEN` | Versioned history; each save is a commit. Data repo: `unevengoat/ln-translator-data` (private) |
| **Cloudflare R2** | 10 GB free, no egress | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Needs R2 enabled once in the CF dashboard |
| Local disk | free | `DATA_DIR` | Dev only — ephemeral on Render free |

Layout (small files, so no 1 MB API limits):
`db.json`, `index/texts.json`, `texts/<hash>.txt`, `terms/<workId>.json`, `tm/<workId>__<lang>.json`.
Writes are cached and flushed on a debounce **plus an explicit flush after every
meaningful operation**, and `SIGTERM` flushes on shutdown.

Backups: **About → Export everything** (full JSON) and **Import backup** (merges,
never overwrites newer data). `GET /api/export`, `POST /api/import`.

## What the library guarantees

- **Works/identity** — one record per story. Extra chapters, re-uploads and renamed
  titles all map to the same story (identity index, re-pointed on rename).
- **Never deletes by accident** — same chapter index + new text = **new version**
  (old kept, restorable); identical text = **duplicate**, ignored.
- **Translation memory** — keyed by chunk hash per story+language, so identical text
  is never paid for twice and re-reading a chapter is instant.
- **Terms** — one canonical form **per target language** per story. Latin originals
  kept as-is; first model sighting becomes canonical; **your correction wins** and
  rewrites every saved chapter *and* the memory (no re-translation).
- **Model pinning** — each story keeps the model that translated it; a different one
  is only chosen when the pinned model is retired.

## The 30 improvements in this build

**Storage & reliability**
1. Durable free storage (GitHub backend) with auto-selection
2. Cloudflare R2 backend ready to switch on
3. Full export/import backup with merge
4. Graceful `SIGTERM` flush (no lost writes on redeploy)
5. Atomic writes + serialized flush queue (no corruption under concurrency)
6. Retry with exponential backoff + jitter on rate limits/transient errors
7. Rate limiting (read/write buckets per IP)
8. Optional `EDIT_TOKEN` to lock editing once you share more widely
9. `/api/health` with storage + model status
10. Split per-story files (`terms/`, `tm/`) so big libraries stay API-friendly

**Translation quality**
11. Automatic QA lint (untranslated script, missing glossary terms, too-short, model
    loops, unbalanced quotes, translator commentary) surfaced per chapter
12. Story style settings (honorifics, register, translator notes) applied to every chapter
13. Per-story glossary injected into every prompt, longest-term-first
14. Whole-story translation ("translate all chapters to Swedish") that is resumable
15. Free-MT cleanup (punctuation spacing, JP dialogue quotes) from earlier build

**Library & reading**
16. Bulk upload — paste a whole volume; chapter markers auto-split (English + CJK)
17. `.epub` / `.html` / `.txt` / `.md` upload parsed server-side
18. Chapter version history with restore
19. Delete chapter / delete story (deliberate, confirmed)
20. Edit story metadata (title/author/URL/source language)
21. Full-text search across titles, terms and stored translations
22. Activity feed (Wikipedia-style recent changes)
23. Deep links / shareable chapter URLs
24. Reader preferences (font size, theme: auto/light/sepia/dark, side-by-side)
25. Side-by-side original + translation view

**UX & platform**
26. Hash routing (shareable/bookmarkable, back button works)
27. Keyboard shortcuts (←/→ chapters, `t` translate, `o` original, `s` side-by-side)
28. Toast notifications + inline busy states
29. Reading progress + "Continue reading" on the library page
30. PWA (manifest + service worker) for offline reading, plus `robots.txt`/`sitemap.xml`

## Run locally

```bash
npm install
GROQ_API_KEY=... GEMINI_API_KEY=... npm start     # → http://localhost:3000
# without GH_/R2_ vars it uses ./data on disk
```

## CLI (batch chapter files)

```bash
node src/cli.js --in ch1.txt --from ja --to sv --engine ai            # auto chain
node src/cli.js --in ch1.txt --from ja --to en --engine ai --provider groq
node src/cli.js --in ch1.txt --to en --engine free --glossary samples/glossary.txt
```

## API

`GET /api` lists everything. Highlights:

```
GET  /api/health | /api/stats | /api/activity | /api/search?q=
GET  /api/works?q=            POST /api/works            POST /api/works/bulk
GET  /api/works/:id           PATCH /api/works/:id        DELETE /api/works/:id
GET  /api/works/:id/chapters/:cid?lang=sv
POST /api/works/:id/chapters/:cid/translate        DELETE /api/works/:id/chapters/:cid
POST /api/works/:id/chapters/:cid/versions/:hash/restore
POST /api/works/:id/translate-all
GET  /api/works/:id/terms?lang=sv                   POST /api/works/:id/terms
GET  /api/works/:id/glossary?lang=sv&format=csv     POST /api/works/:id/glossary
POST /api/parse-file           GET /api/export      POST /api/import
POST /api/translate
```

## Tests

```bash
npm test     # 56 tests: storage backends (local/GitHub/R2 signing), library,
             # terms, QA lint, model policy — all offline
```

## Honest limits

- The GitHub backend commits per flush; heavy simultaneous editing by many people
  would benefit from Postgres. The store is isolated behind one seam (`src/store.js`).
- Render's **free** plan sleeps after ~15 min idle (first request afterwards is slow)
  and has no disk — that's exactly why storage lives in GitHub/R2.
- The `GH_TOKEN` on Render is your `gh` OAuth token (repo scope). Rotate it if ever leaked.
