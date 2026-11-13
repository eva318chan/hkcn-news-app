-- Gemini credit top-ups — run once in Supabase Dashboard → SQL Editor.
-- Records every manual prepayment for the Gemini API key, so the batch
-- admin page can show the estimated remaining credit (in USD) and how
-- many Lite images it can still buy. Admin-only table: RLS is enabled
-- with NO public policies, so the anon and authenticated roles cannot
-- read or write it. All access goes through the server-side service key
-- inside /api/admin/batch.js (actions credit-summary / credit-topup-add).
-- Idempotent: safe to re-run (create table/index if not exists; the seed
-- insert is guarded by NOT EXISTS).
--
-- Anchor (user's Cloud billing screenshots, 2026-11-13 — do not guess):
--   prepaid HK$160.00 on 2026-11-12 (Visa ••••9616, to open the Gemini
--   API for image generation); Google-verified usage HK$16.79 as of
--   2026-11-13, so remaining at anchor = HK$143.21. At that same moment
--   the batch page's total spend was US$1.6000 (85 generated images) —
--   that US$1.60 is already inside the HK$16.79 and must NOT be
--   subtracted again. The remaining-credit formula (see
--   api/admin/batch.js creditEstimate, and the batch page) is:
--     totalUsedHKD = 16.79 + max(0, batchTotalSpendUSD − 1.6000) × rate
--     remainingHKD = sum(topups) − totalUsedHKD
--     remainingUSD = remainingHKD / rate
--     imagesRemaining = floor(remainingUSD / 0.0168)   (Lite batch price)

create table if not exists public.gemini_credit_topups (
  id uuid primary key default gen_random_uuid(),
  amount_hkd numeric(12, 2) not null check (amount_hkd > 0),
  topped_up_at date not null,              -- prepayment date (Hong Kong day)
  note text,                               -- e.g. card used, purpose
  created_at timestamptz not null default now(),
  created_by text                          -- admin email that recorded it
);
create index if not exists gemini_credit_topups_date_idx on public.gemini_credit_topups (topped_up_at desc);

-- Seed: the HK$160.00 prepayment of 2026-11-12.
insert into public.gemini_credit_topups (amount_hkd, topped_up_at, note, created_by)
select 160.00, '2026-11-12', 'Prepaid to open the Gemini API for image generation (Visa ••••9616)', 'seed'
where not exists (
  select 1 from public.gemini_credit_topups
  where amount_hkd = 160.00 and topped_up_at = '2026-11-12'
);

-- Admin-only: no public access at all. The service key bypasses RLS, so
-- the batch endpoint can read/write; the browser (anon/authenticated) cannot.
alter table public.gemini_credit_topups enable row level security;
