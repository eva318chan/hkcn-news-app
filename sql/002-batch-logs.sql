-- Batch action log — run once in Supabase Dashboard → SQL Editor,
-- after supabase/migrations/001_articles.sql, 002_image_prompt.sql and
-- sql/001-batch-tables.sql. One row per batch action (create / check /
-- approve / reject), success and failure both, so the admin batch page can
-- show what happened when a button was clicked — and so a silent failure
-- like the 2026-11-13 "Submit batch showed nothing" case can be traced.
-- The endpoint (api/admin/batch.js) writes the rows; reads (list-articles
-- / list-batches / list-items / stats / list-logs) are console-only and are
-- NOT written here, so normal page loads do not flood the table.
-- Idempotent: safe to re-run (create table/index if not exists).
--
-- How to read it:
--   * Admin batch page → "操作記錄 (Log)" section (latest 50, newest first).
--   * Vercel dashboard → hkcn-news-app → Logs (Runtime Logs): every action
--     is also logged to console as one JSON line starting with "[batch]".

create table if not exists public.batch_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor text,                          -- admin email that did the action
  action text not null,                -- create | check | approve | reject
  batch_id text,                       -- Gemini batch name (batches/xxx) or batch row id, when known
  detail text,                         -- one-line summary, e.g. model=..., articles=8
  ok boolean not null default true,    -- false when the action failed
  error text                           -- failure message, when ok = false
);
create index if not exists batch_logs_created_idx on public.batch_logs (created_at desc);
create index if not exists batch_logs_action_idx on public.batch_logs (action, created_at desc);

-- Admin-only: no public access at all. The service key bypasses RLS, so the
-- batch endpoint can read/write; the browser (anon/authenticated) cannot.
alter table public.batch_logs enable row level security;
