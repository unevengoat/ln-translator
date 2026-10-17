# LN Translator — Light Novel & Web Novel Library

Translate **and keep** light novels / web novels — by **volume** and chapter, with
consistent names across the whole story, into any language. Groq-quality English,
Spanish and Swedish from Japanese / Korean / Chinese / English originals.

- **Live site:** https://ln-translator.onrender.com
- **Models:** Groq `openai/gpt-oss-120b` primary → Gemini `gemini-flash-latest` backup.
  **There is no keyless/offline MT path** — if both models are unavailable it stops and
  asks for a fresh key instead of shipping a worse translation.
- **Storage:** durable and free (GitHub repo, or Cloudflare R2) — survives redeploys
- **Tests:** `npm test` → 62 tests, no network needed

## Adding content (the easy flow)

One screen, one button. On the **Add** tab:

1. Story title + author (and optionally a Volume name).
2. Paste **one chapter, several chapters, or a whole volume** — or upload
   `.txt` / `.md` / `.html` / `.epub`.
3. Markers are detected automatically: `Volume 2`, `Vol. 2`, `第1巻`, `Chapter 3`,
   `第2話`. The source language is auto-detected too.
4. Press **Preview split** to see exactly what will be created.
5. Pick language(s) and press **Save & translate**. **Save only** stores without translating.

From a story page you can also press **＋ Add to this story** (pre-fills title/author/
URL, so new chapters always land in the same story) or **Translate whole story** to
fill in every missing chapter for the selected language.

## Volumes

- A chapter is identified by **(volume, chapter index)** — so "Volume 2 / Chapter 1" is
  *not* a new version of "Volume 1 / Chapter 1".
- Chapter numbers auto-increment **within their volume**.
- The reader gets a volume selector, and Prev/Next walks across volume boundaries.
- Volume markers are optional: without one, chapters simply live in the default group.

## Free, durable storage (fixes "library resets on redeploy")

The library lives outside the app container. `src/store.js` auto-selects a backend,
first configured wins:

| Backend | Cost | Env vars | Notes |
|---|---|---|---|
| **GitHub repo** (default, live now) | free forever | `GH_DATA_REPO`, `GH_TOKEN` | Versioned history; each save is a commit. Data repo: `unevengoat/ln-translator-data` (private) |
| **Cloudflare R2** | 10 GB free, no egress | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Needs R2 enabled once in the CF dashboard |
| Local disk | free | `DATA_DIR` | Dev only — ephemeral on Render free |

Data layout: `db.json`, `index/texts.json`, `texts/<hash>.txt`, `terms/<workId>.json`,
`tm/<workId>__<lang>.json`.

### Does it fully work?

Yes — verified end to end on the live site: a chapter was added, a full redeploy was
forced, and the chapter and its Swedish translation were still there afterwards
("✅ SURVIVED REDEPLOY"). Terms, memory, versions and translations all read back
correctly from a brand-new container.

### Other fully-free options

- **GitHub repo** (this one) — free forever, versioned. Best all-round.
- **Cloudflare R2** — 10 GB free, no egress fees. Needs R2 enabled in the dashboard.
- A **Render Disk** — durable but *not* free (paid instance types only).
- Free Postgres (Neon/Supabase/Turso) — free tiers exist but need a signup; the store
  is isolated behind one seam in `src/store.js` if you ever want to move.

## Locking the token down (important)

Right now `GH_TOKEN` on Render is your **`gh` OAuth token**, which can read/write
**every repository you own**. Replace it with a **fine-grained token scoped to one repo**:

1. GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** → Generate new token.
2. **Repository access:** *Only select repositories* → `unevengoat/ln-translator-data`.
3. **Permissions:** Repository permissions → **Contents: Read and write** (nothing else).
4. Copy the token, then on Render → your service → Environment → set `GH_TOKEN` to it and save.
5. The About page and `/api/health` now report the token: you'll see
   "✅ Token is scoped narrow" instead of the broad-scope warning.

No code change is needed — same env var, and the app reports which kind of token it sees.

## How updates happen automatically

- **Code:** Render is set to auto-deploy on push (`autoDeploy: commit`), so any
  `git push` to `main` rebuilds and releases the site.
- **Data:** every save is written to storage immediately (with a short debounce),
  and pending writes are flushed on `SIGTERM`, so an idle shutdown or redeploy can't
  lose work.
- **Hand edits / another instance:** this instance compares the storage revision at
  most every 2 minutes and reloads if `db.json` changed; you can also press
  **Reload library from storage** (About page) or `POST /api/reload` for an instant refresh.

## Backups

**About → Export everything** (full JSON) and **Import backup** (merges, never
overwrites newer data). Also `GET /api/export` and `POST /api/import`.

## What the library guarantees

- **Never deletes by accident** — same (volume, chapter) + new text = **new version**
  (old kept, restorable); identical text = **duplicate**, ignored.
- **Translation memory** — chunk-keyed per story+language, so identical text is never
  paid for twice and re-reading is instant.
- **Terms** — one canonical form **per target language** per story; your correction wins
  and rewrites every saved chapter *and* the memory (no re-translation).
- **Model pinning** — each story keeps the model that translated it; a different one is
  only chosen when the pinned model is retired.

## Run locally

```bash
npm install
GROQ_API_KEY=... GEMINI_API_KEY=... npm start     # → http://localhost:3000
# without GH_/R2_ vars it uses ./data on disk
```

## CLI (batch chapter files)

```bash
node src/cli.js --in ch1.txt --from ja --to sv                 # groq → gemini chain
node src/cli.js --in ch1.txt --from ja --to en --provider groq --model openai/gpt-oss-120b
node src/cli.js --in ./chapters --from zh-CN --to es --glossary samples/glossary.txt
```

## API

`GET /api` lists everything. Highlights:

```
GET  /api/health | /api/stats | /api/activity | /api/search?q=
GET  /api/works?q=            POST /api/works (volume, chapterIndex, autoTranslateTo)
POST /api/works/bulk          POST /api/works/preview-split
GET  /api/works/:id           PATCH /api/works/:id        DELETE /api/works/:id
GET  /api/works/:id/chapters/:cid?lang=sv
POST /api/works/:id/chapters/:cid/translate        DELETE /api/works/:id/chapters/:cid
POST /api/works/:id/chapters/:cid/versions/:hash/restore
POST /api/works/:id/translate-all
GET  /api/works/:id/terms?lang=sv                   POST /api/works/:id/terms
GET  /api/works/:id/glossary?lang=sv&format=csv     POST /api/works/:id/glossary
POST /api/parse-file          POST /api/reload      GET /api/export      POST /api/import
POST /api/translate
```

## Tests

```bash
npm test   # 62 tests: storage backends (local/GitHub/R2 signing), library, volumes,
           # terms, QA lint, model policy, front-end syntax/assets
```

## Honest limits

- The GitHub backend commits per flush; heavy simultaneous editing by many people would
  benefit from Postgres. The store is isolated behind one seam (`src/store.js`).
- Render's **free** plan sleeps after ~15 min idle (first request afterwards is slow) and
  has no disk — that's exactly why storage lives in GitHub/R2.
- Editing is open to anyone with the link until you set `EDIT_TOKEN`.
