# hkcn-news-app — 港速報 web app (parallel build)

New application for 港速報 / HK-China News Express, built **in parallel** with the
existing static site. The static site (`eva318chan/hkcn-news` → hkcnexpress.com)
keeps running and publishing untouched until this app passes parity and is
switched over. Sports site (`hksports.hk`) is out of scope for this repo.

Plan: `~/workspace/goals/hkcn-news-sites-backfill-and-scheduled-updates/files/hkcn-news-r2-db-migration-plan.md`

## Architecture

```
Reader → Vercel (hkcn-news-app)
  ├── index.html + assets/*            static shell (same look as today)
  ├── assets/app.js                    homepage: calls /api/articles, not data/*.json
  ├── design/202611/*.jpg              the 5 AI design images (seed copy; R2 later)
  ├── api/articles.js                  list / paginate / filter / search
  ├── api/article.js                   one article as JSON
  ├── api/article-page.js              /a/<id>.html — server-rendered, og tags in HTML
  ├── api/meta.js                      dates + counts (replaces data/manifest.json)
  ├── api/sitemap.xml.js / rss.xml.js  generated live from the store
  ├── api/ingest.js                    POST with x-ingest-secret — the only write path
  ├── admin/index.html                 admin UI (Google SSO, see below)
  └── api/admin/*                      admin API (all routes require the Google SSO session)
        ├── Supabase Postgres (articles table) — DATABASE ONLY
        └── Cloudflare R2 (images.hkcnexpress.com) — PRIMARY IMAGE STORE
```

**Images are R2, not Supabase Storage** (confirmed decision, 2026-11-13):
R2 free tier is 10 GB storage with free egress; Supabase Storage free tier is
1 GB with $0.09/GB egress over that. A public news site's cost is image
traffic, so images and the database stay separate — one side blowing up cannot
take the other down. Same split as Project 1943 (video in R2, DB stores the
reference). Supabase is database only in this app; no Supabase Storage bucket
is used or needed.

## Data seam (env-only switch, no code change)

`api/lib/data.js` is the single seam:

| | Seed mode (staging, now) | Live mode (after setup) |
|---|---|---|
| Articles | `data/seed.json` (snapshot of the live repo, 2,355 rows) | Supabase `articles` table via REST (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) |
| Design images | `/design/202611/<file>` served from this repo | `https://images.hkcnexpress.com/design/202611/<file>` (`R2_PUBLIC_BASE_URL`) |
| Other images | source `og:image` hotlink, unchanged | same |

When the env vars appear, the app switches automatically. Nothing else changes.

## Env vars (Vercel → hkcn-news-app → Settings → Environment Variables)

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | for live DB | e.g. `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | for live DB + ingest | service_role key — **server-side only, never in the browser or repo** |
| `R2_PUBLIC_BASE_URL` | for live images | `https://images.hkcnexpress.com` |
| `INGEST_SECRET` | for publishing | long random string; same value in the Bella pipeline |
| `GOOGLE_CLIENT_ID` | for admin sign-in | Google OAuth client id (public id, not a secret); the OAuth client must allow the origin `https://hkcn-news-app-eva318chan.vercel.app` and the callback `/api/admin/auth/callback` |
| `ADMIN_EMAILS` | for admin sign-in | comma-separated allowlist of Google accounts allowed into `/admin/` (e.g. `eddiehlk@gmail.com,eva318.chan@gmail.com`) |
| `ADMIN_SESSION_SECRET` | for admin sign-in | long random string; HMAC key for the admin session cookie — server-side only, never in the browser or repo |
| `SITE_URL` | optional | defaults to the request host; set `https://hkcnexpress.com` in production |

No secret, token or key is in this repo. See `.env.example`.

## Admin (`/admin/`)

The admin lives in this same project (no separate app). It manages the
articles in Supabase: list/search (paginated, newest first, all statuses),
edit an article's titles, summaries, tags, category, image URL and status,
unpublish (status `draft` — hidden from the public site), and delete (the UI
confirms first). Articles have no full body column — the editable text is
`title_*` / `summary_*` in en/zh_hant/zh_hans, and the article page renders
the summary as its content.

**Auth is Google SSO only — no passwords.** The admin page shows a Google
Sign-In button (Google Identity Services); the ID token is sent to
`/api/admin/auth/callback`, which verifies it with Google, checks the email
against `ADMIN_EMAILS`, and sets a signed httpOnly session cookie (HMAC with
`ADMIN_SESSION_SECRET`, 7 days). Every `/api/admin/` route shares that one
auth check (`api/lib/admin-auth.js`); unauthenticated requests get 401 and
never see article data. If any of `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS` or
`ADMIN_SESSION_SECRET` is missing, sign-in fails closed. Sign-in is not
testable without a real allowlisted Google account — staging verification
covers only the unauthenticated behaviour (`/admin/` shows the sign-in, not
data; `/api/admin/articles` returns 401).

**Public site only shows `published` rows.** `/api/articles`, `/api/article`,
`/a/<id>.html`, sitemap and RSS all filter `status=eq.published` (and seed
mode filters drafts too), so setting an article to `draft` unpublishes it
everywhere at once.

**One-time R2 migration (`POST /api/admin/r2-migrate`, admin session only).**
The R2 credentials are stored encrypted in Vercel — readable by serverless
functions at runtime, but not readable back through the Vercel API — so no
external script can upload with them. This endpoint uploads from inside the
function instead: it fetches the 5 AI design images from their public GitHub
raw URLs and PUTs each to the R2 bucket (`design/202611/<file>`, Content-Type
`image/jpeg`) using a SigV4-signed S3-compatible PUT (Node's built-in crypto,
no SDK). Credentials come from `process.env` (`R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`). PUTs are idempotent, so
re-running is safe. Returns a JSON summary of keys uploaded with sizes (and
any failures). It is a one-time utility — not part of the publishing pipeline.

## Still missing — dashboard steps for the user (Supabase + R2)

**Supabase (database only)** — main agent handles this; Supabase dashboard login
is already in the Secure Vault:
1. Supabase Dashboard → New project (name e.g. `hkcn-news`, region Singapore
   `ap-southeast-1` — closest to Hong Kong readers).
2. SQL Editor → paste `supabase/migrations/001_articles.sql` → Run. This creates
   the `articles` table, indexes, RLS (public read of `published` rows only) and
   the `articles_meta()` function.
3. Project Settings → API → copy the Project URL → `SUPABASE_URL`, and the
   `service_role` key → `SUPABASE_SERVICE_KEY` (never the `anon` key for writes).
4. Load the seed: `SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/migrate.mjs --to-supabase`
   (upserts by `(site, slug)`, safe to re-run). Verify row count = 2,355.
5. Paste the two values into the Vercel env vars above and redeploy.

**Cloudflare R2 (images)**:
1. Cloudflare Dashboard → R2 Object Storage → Create bucket `hkcn-news-images`
   (location: APAC if offered; otherwise Automatic).
2. R2 → Custom Domains → Connect Domain → `images.hkcnexpress.com` (Cloudflare
   will add the DNS record; the domain must already be on Cloudflare).
3. Upload the 5 files from `design/202611/` to `design/202611/` in the bucket
   (Dashboard upload, or `wrangler r2 object put` / S3 API later from the pipeline).
4. Set `R2_PUBLIC_BASE_URL=https://images.hkcnexpress.com` in the Vercel env
   vars and redeploy. Verify `https://images.hkcnexpress.com/design/202611/20261113-nvidia-huang-resigns-design.jpg`
   returns 200.
5. R2 **write** credentials (S3-compatible API token, write-only on this bucket)
   go to the Bella publishing pipeline, not to this web app. This app never
   uploads images.

## Publishing (after cutover — not active yet)

Each 2-hour pipeline run: search → rewrite → generate AI design image if needed
→ upload image to R2 (`design/YYYYMM/<file>`) → `POST /api/ingest` with
`x-ingest-secret` and the article JSON → verify the live `/a/<id>.html` URL.
No Git commit, no Vercel deployment. `POST`ing the same `id` again updates the
article (dedupe by `(site, slug)`). `DELETE /api/ingest?slug=<id>` (same secret)
removes one article.

## Migration

`node scripts/migrate.mjs` — fetches the live repo's manifest + every
`data/*.json` + every `a/*.html`, and writes:

- `data/seed.json` — 2,355 rows (verified: manifest total 2,355, 0 duplicates,
  all 2,355 article HTML files fetched, 0 missing)
- `data/seed-meta.json` — dates/counts/`updated_at` (same numbers as manifest)
- `supabase/migrations/001_articles.sql` — schema (see above)
- `design/202611/*.jpg` — the 5 design images, byte-identical to the live repo

Two things the JSON files do **not** contain were recovered from the article
HTML so parity is exact: **image captions** (292 articles, pipeline step 5B)
are stored as `image_caption`, and **non-standard footers** (3 articles, e.g.
`配圖為 AI 設計圖片。`) as `footer_note`. Both become nullable columns in the
DB schema — additions to the plan's schema, for parity, not new features.

`node scripts/migrate.mjs --to-supabase` additionally uploads the seed to
Supabase (needs the env vars; run only after the SQL migration).

## Parity notes (checked against the live static site)

- **Homepage order is `published_at` DESC, not image-first.** The pipeline
  sorts each daily JSON image-first (rule 5C), but the live `app.js` re-sorts
  everything by `published_at` before rendering — so the live homepage's top
  stories are the newest ones, with or without images (verified on 2026-11-12:
  file order starts with image articles at 21:35, but the live order starts
  with imageless articles at 23:37). The API defaults to the live order so the
  homepage matches; `?sort=image_first` returns the 5C order explicitly.
- **Search is better, not worse.** The live homepage only searches articles
  already loaded (first 7 days, then more via load-more). The new API searches
  the whole corpus server-side. Same query box, wider results.
- **Meta count is the server total**, not the number of cards currently loaded.
- **Article pages** replicate the static template (same classes, same header,
  same language-switch script — now fetching `/api/article` instead of the
  daily JSON), including captions and the AI-image footer where present.
- **Sitemap/RSS** use the request host (staging host on staging,
  `hkcnexpress.com` in production via `SITE_URL`), so compare slugs, not hosts.
- **Ingest in seed mode returns 503** (after auth): there is no database to
  write to, and staging must not pretend an insert succeeded. The 401
  (wrong/missing secret) and 400 (bad body) paths are testable on staging; the
  insert→verify→delete test needs the Supabase project from the steps above.
- **Paging is server-side:** `/api/articles` fetches only the requested page
  from PostgREST (limit + offset, `Prefer: count=exact`, total from the
  Content-Range header) — the earlier whole-corpus fetch took ~7s for
  `?limit=20`; one page now returns in well under 1s. Tag + search are
  combined into one PostgREST `and` group, so both apply server-side. Date
  filters use the Hong Kong day window (the same day the `/api/meta` chips
  count); this also fixed the old date bug where articles published
  16:00–24:00 UTC were invisible under every date filter. The homepage loads
  one page at a time: the Load More button fetches the next page, and
  scrolling it into view does the same automatically — the full 2,355
  articles are never preloaded.

## Local test

```bash
node scripts/serve.mjs 3100   # http://localhost:3100 (seed mode, no env needed)
# With a test ingest secret (seed mode: auth works, insert returns 503):
INGEST_SECRET=test-secret node scripts/serve.mjs 3100
```

## Files

| Path | What it is |
|---|---|
| `index.html`, `assets/style.css`, `assets/logo-*.png`, `assets/favicon.png` | copied verbatim from the live repo |
| `assets/app.js` | live `app.js` with only the data loading changed (diff it: theme/i18n/render/share code is identical) |
| `api/lib/data.js` | the data seam (seed ↔ Supabase, R2 ↔ local images) |
| `api/*.js` | Vercel serverless functions (no dependencies, no framework) |
| `admin/index.html` | admin UI (Google SSO; calls `/api/admin/*`) |
| `api/lib/admin-auth.js` | shared Google SSO session check for all `/api/admin/` routes |
| `api/admin/config.js`, `api/admin/auth/callback.js`, `api/admin/auth/logout.js` | admin sign-in: client-id config, ID-token exchange, logout |
| `api/admin/articles.js` | admin article list / get / edit / delete |
| `api/admin/r2-migrate.js` | one-time upload of the 5 design images to R2 (SigV4, no SDK) |
| `data/seed.json`, `data/seed-meta.json` | migration snapshot (regenerate with `scripts/migrate.mjs`) |
| `design/202611/*.jpg` | the 5 design images in R2 layout |
| `scripts/migrate.mjs`, `scripts/serve.mjs` | migration + local dev server |
| `supabase/migrations/001_articles.sql` | DB schema + RLS + `articles_meta()` |
| `vercel.json` | rewrites `/a/:slug.html`, `/sitemap.xml`, `/rss.xml`; 307 redirect `/assets/design/*` → `/design/202611/*` |
