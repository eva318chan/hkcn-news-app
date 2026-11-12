-- hkcn-news articles table — run once in Supabase Dashboard → SQL Editor.
-- New Supabase project for news (separate from the KongTalk project).
-- Seed data is loaded afterwards with: node scripts/migrate.mjs --to-supabase
-- (SUPABASE_URL + SUPABASE_SERVICE_KEY in env, never in the repo).
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  site text not null,                      -- 'hkcn' or 'hksports'
  slug text not null,                      -- article id, e.g. 20261113-nvidia-huang-resigns
  category text not null,
  published_at timestamptz not null,
  source_name text not null default '',
  source_url text not null default '',
  image_url text,                          -- final display URL (R2 URL or source og:image hotlink)
  image_r2_key text,                       -- e.g. design/202611/20261113-nvidia-huang-resigns-design.jpg
  image_caption text,                      -- ISD caption from pipeline step 5B (null when none)
  footer_note text,                        -- non-standard footer, e.g. AI design image note
  title_en text not null default '',
  title_zh_hant text not null default '',
  title_zh_hans text not null default '',
  summary_en text not null default '',
  summary_zh_hant text not null default '',
  summary_zh_hans text not null default '',
  tags_en text[] not null default '{}',
  tags_zh_hant text[] not null default '{}',
  tags_zh_hans text[] not null default '{}',
  status text not null default 'published', -- 'published' | 'draft'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site, slug)
);
create index if not exists articles_site_published_idx on public.articles (site, published_at desc);
create index if not exists articles_site_category_idx on public.articles (site, category, published_at desc);
create index if not exists articles_tags_hant_idx on public.articles using gin (tags_zh_hant);
create index if not exists articles_search_idx on public.articles
  using gin (to_tsvector('simple', coalesce(title_zh_hant,'') || ' ' || coalesce(summary_zh_hant,'') || ' ' || coalesce(title_en,'') || ' ' || coalesce(summary_en,'')));

-- Public read-only: only published rows. No direct writes from the browser;
-- writes go through the server-side ingest function with the service key.
alter table public.articles enable row level security;
drop policy if exists "public read published" on public.articles;
create policy "public read published" on public.articles
  for select to anon, authenticated using (status = 'published');

-- Homepage meta (date chips + counts) for /api/meta. Same numbers as the old
-- data/manifest.json. Read-only, published rows only.
create or replace function public.articles_meta()
returns jsonb
language sql security definer
as $$
  select jsonb_build_object(
    'updated_at', (select max(published_at) from public.articles where status = 'published'),
    'total', (select count(*) from public.articles where status = 'published'),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day desc)
      from (select to_char(published_at at time zone 'Asia/Hong_Kong', 'YYYY-MM-DD') as day,
                   count(*) as cnt
            from public.articles where status = 'published' group by day) s
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.articles_meta() to anon, authenticated;
