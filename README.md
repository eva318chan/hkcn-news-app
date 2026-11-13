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
  ├── api/ingest.js                    POST with x-ingest-secret — the pipeline write path
  ├── api/ingest-image.js              POST with x-ingest-secret — pipeline image upload to R2
  ├── lib/r2.js                        SigV4 S3 PUT helper (shared by ingest-image)
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

`lib/data.js` is the single seam:

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
| `GEMINI_API_KEY` | for batch images | Gemini API key — server-side only, never in the browser or repo. The batch endpoint reads it from env; if it is missing, Generate fails with a clear message telling the admin to set it in Vercel |
| `GOOGLE_CLIENT_ID` | for admin sign-in | Google OAuth client id (public id, not a secret); the OAuth client must allow the origin `https://hkcn-news-app-eva318chan.vercel.app` and the callback `/api/admin/auth/callback` |
| `ADMIN_EMAILS` | for admin sign-in | comma-separated allowlist of Google accounts allowed into `/admin/` (e.g. `eddiehlk@gmail.com,eva318.chan@gmail.com`) |
| `ADMIN_SESSION_SECRET` | for admin sign-in | long random string; HMAC key for the admin session cookie — server-side only, never in the browser or repo |
| `SITE_URL` | optional | defaults to the request host; set `https://hkcnexpress.com` in production |

No secret, token or key is in this repo. See `.env.example`.

## Admin (`/admin/`)

The admin lives in this same project (no separate app). It manages the
articles in Supabase: create a new article, list/search (paginated, newest
first, all statuses), edit an article's titles, summaries, tags, category,
image URL and status, unpublish (status `draft` — hidden from the public
site), and delete (the UI confirms first). Articles have no full body
column — the editable text is `title_*` / `summary_*` in en/zh_hant/zh_hans,
and the article page renders the summary as its content.

**Admin API — create / update without touching the DB.** `POST
/api/admin/articles` creates an article and `PATCH
/api/admin/articles?id=<slug>` updates one; both need the admin Google SSO
session (401 without it) and return 503 in seed mode (no database to write
to). Create payload:

```json
{ "slug": "20261113-example-news",
  "title_zh_hant": "標題", "title_en": "Title",
  "summary_zh_hant": "摘要…", "tags_zh_hant": ["香港"],
  "category": "hongkong", "status": "published",
  "source_name": "政府新聞處", "source_url": "https://…",
  "image_url": "https://…", "image_prompt": "AI 設計圖 prompt…" }
```

Only a title (`zh_hant` or `en`) is required. `slug` is optional — when
omitted it is auto-derived from the English title (lowercase letters, digits
and hyphens only; dots are rejected with 400, because a dotted slug broke the
old `/a/<id>.html` routing). `published_at` defaults to now; `status`
defaults to `published` (`draft` unpublishes); `category` defaults to
`other`. Creating with a slug that already exists returns 409 and never
overwrites — use PATCH to update. PATCH accepts the same fields (plus
`image_r2_key`, `image_caption`, `footer_note`); omitted fields are left
unchanged. `image_prompt` is only stored when migration 002 has been applied
to the database (`supabase/migrations/002_image_prompt.sql`).

**The automated pipeline keeps using `POST /api/ingest` with
`INGEST_SECRET`.** The cron cannot hold a Google SSO session, so the admin
API is for human / admin use only — pipeline publishing is unchanged (see
Publishing below).

**Auth is Google SSO only — no passwords.** The admin page shows a Google
Sign-In button (Google Identity Services); the ID token is sent to
`/api/admin/auth/callback`, which verifies it with Google, checks the email
against `ADMIN_EMAILS`, and sets a signed httpOnly session cookie (HMAC with
`ADMIN_SESSION_SECRET`, 7 days). Every `/api/admin/` route shares that one
auth check (`lib/admin-auth.js`); unauthenticated requests get 401 and
never see article data. If any of `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS` or
`ADMIN_SESSION_SECRET` is missing, sign-in fails closed. Sign-in is not
testable without a real allowlisted Google account — staging verification
covers only the unauthenticated behaviour (`/admin/` shows the sign-in, not
data; `/api/admin/articles` returns 401).

**Public site only shows `published` rows.** `/api/articles`, `/api/article`,
`/a/<id>.html`, sitemap and RSS all filter `status=eq.published` (and seed
mode filters drafts too), so setting an article to `draft` unpublishes it
everywhere at once.

**Batch images (POC, 2026-11-13).** The batch image function lives on its
own page, `/admin/batch/` (linked from the main admin page's top
navigation as "Batch images（批量生圖）", with a link back to
`/admin/`), and generates AI design images with the Gemini Batch API —
the only image-generation path now. Step 5D (immediate Gemini image
generation in the pipeline) is PAUSED (user decision 2026-11-13); the
pipeline only prepares a Chinese prompt per SOP for each new imageless
article (step 5E) and stores it in `image_prompt`. Manual flow: the admin
selects articles, clicks Generate, clicks Check, reviews the images and
approves — the user controls every step.

**Fully automatic flow (2026-11-13, user decision: "全自動，連批准都自動").**
The 2-hour pipeline's step 5F auto-submits ONE Gemini batch (model
`gemini-3.1-flash-lite-image`, the cheapest at $0.0168/image batch) for
every published article that has an `image_prompt`, no image yet, and no
item already in a pending batch; a 5-minute cron then polls every pending
auto batch, downloads finished images to R2 staging, and auto-approves
each generated item (same copy to `design/<YYYYMM>/` + article link as
the manual Approve button). Failures stay failed and are never
auto-approved. Auto actions authenticate with `INGEST_SECRET`
(`x-ingest-secret`), not Google SSO — a cron has no browser session —
and only ever touch batches the auto flow created itself (`created_by`
"auto"); manual batches stay fully manual (the user still checks and
approves those in the admin). The user accepted that auto-approved images
go live without a human eyeball check. Batches and per-model spend show
on the batch page exactly like manual ones (the stats area counts every
generated image, auto or manual).

Flow: article list (date range, default today; "without image" default;
each row is checkbox + category + title + a labelled `圖片 prompt`
textarea — edits save on blur via the existing articles PATCH) → the
model picker is shown by default (Lite / Flash Image / Pro Image, each
with its batch price), Flash Image pre-selected; one click on Generate
submits → the BatchID list shows each batch with a Check button → Check
downloads the results to R2 staging
(`staging/design/<batch-id>/<slug>.jpg`) → the review list shows each
generated image with its news title and Approve / Reject buttons, plus
全部批准 (Approve All) and 全部拒絕 (Reject All) buttons above the list
(each asks for confirmation with the count first, and both are disabled
when nothing is generated; a bulk run loops the same per-item
approve/reject calls, so each item is logged exactly as if clicked
individually) → Approve copies the image to `design/<YYYYMM>/<slug>.jpg`
in R2 and links it to the article (`image_url` + `image_r2_key`); Reject
keeps the staging copy in R2 so the image stays viewable — rejected items
remain listed in the batch 詳情 view and in a 已拒絕 section under the
review list (user decision 2026-11-13, previously Reject deleted the
staging copy). The usage-stats area shows per-model images generated so
far + cost so far (generated × batch price) + total.

Check reads Gemini's double-nested `inlinedResponses` (verified
2026-11-13: both `response` and `metadata.output` carry
`{"inlinedResponses": [...]}` — the endpoint unwraps either shape, so a
finished batch's images are actually downloaded instead of every item
failing). Each batch row has a 詳情 button showing every article's
title, status and per-item error; after a Check with failures that batch
opens automatically. The check log entry lists which slugs generated /
failed and why. A per-item error is shown in red only when the item
failed — when an item is marked generated or approved its error is
cleared (and any stale error is swept on the next Check or detail view),
so a successful item never shows an old failure in red (user report
2026-11-13).

Check matches every result to its article BY KEY (`metadata.key` is the
slug) — never by position, because Gemini does not return results in
request order (verified 2026-11-13: a 10-article batch came back
shuffled, and a position zip wrote the wrong image into 2 of 10 staging
files). A re-Check on a finished batch re-downloads every generated
item's image by key and overwrites its staging file, so it repairs a
wrong file instead of leaving it in place; two overlapping Checks are
safe for the same reason (both write the same correct bytes).

Batch size is a recommendation, not a hard limit (user decision
2026-11-13: "endpoint 放寬，warning 照去"): the page suggests ~10 per
batch and warns above that, but the endpoint accepts whatever the user
confirms. Every batch action shows a visible status message on the page
(success green, error red, using the server's message) — a click never
silently does nothing (2026-11-13 fix: Generate used to fail silently
when `GEMINI_API_KEY` was not yet in the live deployment).

Logging (user request 2026-11-13: "add log"): every batch action is
logged to console as one JSON line starting with `[batch]` (read it in
Vercel → hkcn-news-app → Logs / Runtime Logs), and create / check /
approve / reject / auto-submit / auto-poll are also written to the
`batch_logs` table, shown on
the batch page under "操作記錄 (Log)" (latest 50, newest first;
successes and failures both). If the log table is not created yet, the
section says so instead of failing.

One endpoint, `POST /api/admin/batch` (Google SSO for the manual
actions; `INGEST_SECRET` for the two auto actions `auto-submit` and
`auto-poll` only — auto auth never grants a manual action), with an
`action` field: `list-articles`, `create`, `check`, `approve`, `reject`,
`list-batches`, `list-items`, `list-logs`, `stats`, `auto-submit`,
`auto-poll`. Batch price is half of standard (verified 2026-11-13: Lite
~$0.017, Flash 1K ~$0.034, Pro 1K/2K ~$0.067 per image). Prices live in
`gemini_model_prices` (check weekly; a model with an unknown price is
shown as "待確認", never guessed); the endpoint falls back to the verified
prices above when the table is empty. DB tables
(`sql/001-batch-tables.sql` and `sql/002-batch-logs.sql` — run once each
in the Supabase SQL Editor, both are idempotent): `image_batches`,
`image_batch_items`, `gemini_model_prices`, `batch_logs`.
This endpoint is the 12th and last serverless function (Hobby limit 12) —
no further endpoint can be added without merging or removing one.

**R2 migration (done 2026-11-13, endpoint removed).** The 5 AI design images
were uploaded to the `hkcn-news-images` bucket (`design/202611/<file>`) via
the admin migrate button, and the articles now serve them from the R2 public
URL. The button and its `POST /api/admin/r2-migrate` endpoint were removed
afterwards — the endpoint only handled those 5 files, and removing it freed
a serverless-function slot (at the time; the app is now at 12/12 — see Batch
images above). New design images from the pipeline
go through the permanent `POST /api/ingest-image` endpoint instead (see
Publishing below), so no further backfill is needed for new articles.

**Logout is server-side, not an endpoint of its own.** The session cookie is
HttpOnly, so JavaScript cannot clear it — the old `document.cookie` clear
never worked (the session stayed valid until expiry). The admin page POSTs
`{ action: "logout" }` to `/api/admin/auth/callback`, which expires
`hkcn_admin_session` with `Max-Age=0`. No separate logout endpoint exists —
the existing callback handles it, deliberately, to stay under Vercel's
12-serverless-functions-per-deployment Hobby limit.

**Web Analytics.** Enabled on the Vercel dashboard (Hobby free: 50,000
events/month, 30 days history). No npm package is installed — this site has
no build step. Instead the pages carry exactly what `@vercel/analytics` v2
`inject()` does in production, verified against the published package
source: the `window.va` stub plus `<script defer
src="/_vercel/insights/script.js">` (in `index.html`, `admin/index.html`,
and the article template in `api/article-page.js`). The dashboard's
Get Started shows no plain-HTML snippet, but the v2 package source confirms
this is the script `inject()` loads. Page views should appear in the
dashboard (Analytics → Countries / Referrers / Devices) ~30 s after a visit.

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

**Image upload (`POST /api/ingest-image`, same `x-ingest-secret` auth as
`/api/ingest`).** The pipeline's route for design images into R2 — the cron
cannot hold a Google SSO session, so admin endpoints are unusable by it, and
the R2 credentials are only readable by serverless functions at runtime.
Body: `{ key, sourceUrl }` (the function fetches the image and PUTs it to R2)
or `{ key, contentBase64, contentType }` (direct upload). The key must match
`^design/YYYYMM/<name>.(jpg|jpeg|png|webp)$` — anything else is rejected
with 400. Response: `{ ok:true, key, url, bytes }` where `url` is
`R2_PUBLIC_BASE_URL + "/" + key`; the article is then ingested with
`image_url` = that URL and `image_r2_key` = the key. Uploads are idempotent,
so re-uploading the same key is safe. If the upload fails, the pipeline keeps
the old behaviour (image served from the old site's live URL, logged as
"待 R2 backfill") and never blocks publishing on it. Signing is SigV4
(`lib/r2.js`, Node built-in crypto, no SDK).

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
| `lib/data.js` | the data seam (seed ↔ Supabase, R2 ↔ local images) |
| `api/*.js` | Vercel serverless functions (no dependencies, no framework). 12 functions — the Hobby limit is 12 per deployment, so this is FULL; no further endpoint can be added without merging or removing one. Shared code lives in root `lib/`, NOT under `api/`, or Vercel would count it as a function |
| `admin/index.html` | admin UI (Google SSO; calls `/api/admin/*`) |
| `lib/admin-auth.js` | shared Google SSO session check for all `/api/admin/` routes |
| `api/admin/config.js`, `api/admin/auth/callback.js` | admin sign-in: client-id config, ID-token exchange (logout is a branch of the callback — server-side cookie expiry) |
| `api/admin/articles.js` | admin article list / get / create / edit / delete |
| `api/admin/batch.js` | Gemini Batch API image generation (POC + fully automatic flow): create / check / approve / reject / list-batches / list-items / list-logs / stats / auto-submit / auto-poll, all behind one `action` field — the 12th function |
| `data/seed.json`, `data/seed-meta.json` | migration snapshot (regenerate with `scripts/migrate.mjs`) |
| `design/202611/*.jpg` | the 5 design images in R2 layout |
| `scripts/migrate.mjs`, `scripts/serve.mjs` | migration + local dev server |
| `supabase/migrations/001_articles.sql` | DB schema + RLS + `articles_meta()` |
| `vercel.json` | rewrites `/a/:slug.html`, `/sitemap.xml`, `/rss.xml`; 307 redirect `/assets/design/*` → `/design/202611/*` |
