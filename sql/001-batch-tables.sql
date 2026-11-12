-- Batch image generation tables — run once in Supabase Dashboard → SQL Editor,
-- after supabase/migrations/001_articles.sql and 002_image_prompt.sql.
-- Admin-only tables: RLS is enabled with NO public policies, so the anon and
-- authenticated roles cannot read or write them. All access goes through the
-- server-side service key (which bypasses RLS) inside /api/admin/batch.js.
-- The Gemini key never leaves the server; the admin page only ever sees
-- batch ids, statuses, staging URLs and costs.
-- Idempotent: safe to re-run (create table/index if not exists, upsert seeds).
--
-- Flow (user-controlled, nothing automatic):
--   1. Admin selects articles (each must have image_prompt, no image yet)
--      and clicks Generate with a model -> a Gemini batch is created.
--   2. Admin clicks Check -> the endpoint polls Gemini; when the batch
--      succeeds it downloads the images to R2 staging/.
--   3. Admin reviews the staging images and clicks Approve (copies to
--      design/YYYYMM/ and links the article) or Reject (deletes staging).

create table if not exists public.image_batches (
  id uuid primary key default gen_random_uuid(),
  gemini_batch_name text unique,           -- e.g. batches/abc123 (Gemini Batch API job name)
  model text not null,                     -- e.g. gemini-3.1-flash-lite-image
  status text not null default 'pending',  -- pending | running | succeeded | failed | cancelled | expired
  created_at timestamptz not null default now(),
  created_by text,                         -- admin email that submitted the batch
  article_count int not null default 0
);
create index if not exists image_batches_created_idx on public.image_batches (created_at desc);

create table if not exists public.image_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.image_batches (id) on delete cascade,
  article_slug text not null,              -- articles.slug (site = 'hkcn')
  status text not null default 'submitted', -- submitted | generated | approved | rejected | failed
  staging_r2_key text,                     -- e.g. staging/design/<batch-id>/<slug>.jpg
  error text,                              -- failure reason, when status = 'failed'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, article_slug)
);
create index if not exists image_batch_items_batch_idx on public.image_batch_items (batch_id);
create index if not exists image_batch_items_status_idx on public.image_batch_items (status, created_at desc);

-- Gemini image-model prices (USD per image). Batch price is half of standard
-- (verified 2026-11-13 from Google's pricing page; re-check weekly — see the
-- admin usage-stats area). The admin page reads this table to show the model
-- picker; if the table is empty the endpoint falls back to these same three
-- prices hard-coded in api/admin/batch.js. Do NOT offer
-- gemini-2.5-flash-image here — it retires 2027-03-15.
create table if not exists public.gemini_model_prices (
  model text primary key,                  -- e.g. gemini-3.1-flash-lite-image
  display_name text not null,              -- e.g. Lite (Nano Banana 2 Lite)
  standard_price_usd numeric not null,     -- standard (sync) price per image
  batch_price_usd numeric not null,        -- batch price per image (half of standard)
  updated_at timestamptz not null default now()
);
insert into public.gemini_model_prices (model, display_name, standard_price_usd, batch_price_usd, updated_at)
values
  ('gemini-3.1-flash-lite-image', 'Lite (Nano Banana 2 Lite)', 0.0336, 0.0168, now()),
  ('gemini-3.1-flash-image', 'Flash Image (Nano Banana 2) — 1K', 0.067, 0.034, now()),
  ('gemini-3-pro-image', 'Pro Image (Nano Banana Pro) — 1K/2K', 0.134, 0.067, now())
on conflict (model) do update set
  display_name = excluded.display_name,
  standard_price_usd = excluded.standard_price_usd,
  batch_price_usd = excluded.batch_price_usd,
  updated_at = now();

-- Admin-only: no public access at all. The service key bypasses RLS, so the
-- batch endpoint can read/write; the browser (anon/authenticated) cannot.
alter table public.image_batches enable row level security;
alter table public.image_batch_items enable row level security;
alter table public.gemini_model_prices enable row level security;
