// Migration: live static repo eva318chan/hkcn-news  →  seed dataset + Supabase SQL.
//   node scripts/migrate.mjs            fetch manifest + every data/*.json + every a/*.html,
//                                       write data/seed.json, data/seed-meta.json,
//                                       supabase/migrations/001_articles.sql,
//                                       download the 5 design images to design/202611/
//   node scripts/migrate.mjs --to-supabase
//                                       same as above, then upload seed rows to Supabase
//                                       (needs SUPABASE_URL + SUPABASE_SERVICE_KEY in env,
//                                       run only after the SQL migration has been applied).
// Reads only from the PUBLIC live repo. Writes nothing to it. No secrets in this file.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = "https://raw.githubusercontent.com/eva318chan/hkcn-news/main";
const SITE = "hkcn";
const CONCURRENCY = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "hkcn-news-app-migrate" } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

async function fetchBin(url) {
  const r = await fetch(url, { headers: { "User-Agent": "hkcn-news-app-migrate" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

const STANDARD_FOOTER = "摘要由本站重新編寫，圖片版權歸原新聞機構所有。";

// Design images live at /assets/design/<file> on the old site.
// In the new app they live at design/202611/<file> until R2 is configured.
function designImageInfo(imageUrl) {
  if (!imageUrl) return null;
  const m = imageUrl.match(/\/assets\/design\/([^/?#]+\.jpg)$/i);
  if (!m) return null;
  return { file: m[1], r2Key: `design/202611/${m[1]}` };
}

async function main() {
  const toSupabase = process.argv.includes("--to-supabase");

  const manifest = JSON.parse(await fetchText(`${LIVE}/data/manifest.json`));
  const dates = manifest.dates || [];
  const manifestTotal = dates.reduce((n, d) => n + (d.count || 0), 0);
  console.log(`manifest: ${dates.length} dates, total ${manifestTotal}, updated_at ${manifest.updated_at}`);

  // 1. Fetch every daily JSON.
  let rows = [];
  for (const d of dates) {
    const arr = JSON.parse(await fetchText(`${LIVE}/data/${d.date}.json`));
    if (arr.length !== d.count) console.warn(`count mismatch ${d.date}: manifest ${d.count}, file ${arr.length}`);
    rows.push(...arr);
  }
  console.log(`articles from JSON: ${rows.length}`);

  // 2. Fetch every article HTML for caption + footer (5B captions and the AI-image
  //    footer live only in the static HTML, not in data/*.json).
  const stats = { htmlOk: 0, htmlMissing: 0, captions: 0, aiFooter: 0, designImages: 0 };
  const seenDesignFiles = new Set();
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const a = rows[idx++];
      const html = await fetchText(`${LIVE}/a/${a.id}.html`).catch(() => null);
      if (!html) { stats.htmlMissing++; a._htmlMissing = true; continue; }
      stats.htmlOk++;
      const cap = html.match(/<p style="font-size:13px;color:#888;margin:8px 0 0">(.*?)<\/p>/s);
      if (cap) { a.image_caption = stripTags(cap[1]); stats.captions++; }
      const foot = html.match(/<footer><p>(.*?)<\/p><\/footer>/s);
      if (foot) {
        const f = stripTags(foot[1]);
        if (f && f !== STANDARD_FOOTER) { a.footer_note = f; stats.aiFooter++; }
      }
      const di = designImageInfo(a.image_url);
      if (di) { a.image_r2_key = di.r2Key; seenDesignFiles.add(di.file); stats.designImages++; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`html ok ${stats.htmlOk}, missing ${stats.htmlMissing}, captions ${stats.captions}, non-standard footers ${stats.aiFooter}, design-image articles ${stats.designImages}`);

  // 3. Normalise to the seed shape (original JSON shape + extras).
  const seed = rows.map((a) => {
    const out = {
      site: SITE,
      id: a.id,
      category: a.category,
      published_at: a.published_at,
      source: a.source || { name: "", url: "" },
      image_url: a.image_url || "",
      title: a.title,
      summary: a.summary,
      tags: a.tags,
      status: "published",
    };
    if (a.image_caption) out.image_caption = a.image_caption;
    if (a.footer_note) out.footer_note = a.footer_note;
    if (a.image_r2_key) out.image_r2_key = a.image_r2_key;
    return out;
  });

  if (seed.length !== manifestTotal) {
    console.error(`MISMATCH: seed rows ${seed.length} != manifest total ${manifestTotal}`);
    process.exitCode = 1;
  }
  const dupes = seed.length - new Set(seed.map((r) => r.id)).size;
  if (dupes) { console.error(`MISMATCH: ${dupes} duplicate ids`); process.exitCode = 1; }

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", "seed.json"), JSON.stringify(seed));
  writeFileSync(join(ROOT, "data", "seed-meta.json"), JSON.stringify({
    updated_at: manifest.updated_at, dates, total: seed.length,
    generated_at: new Date().toISOString(),
    stats,
  }, null, 2));

  // 4. Download the design images into the R2 layout.
  mkdirSync(join(ROOT, "design", "202611"), { recursive: true });
  for (const f of [...seenDesignFiles].sort()) {
    const buf = await fetchBin(`${LIVE}/assets/design/${f}`);
    writeFileSync(join(ROOT, "design", "202611", f), buf);
    console.log(`image ${f} ${buf.length} bytes`);
  }

  // 5. Supabase SQL migration (schema only; seed load is --to-supabase below).
  mkdirSync(join(ROOT, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(ROOT, "supabase", "migrations", "001_articles.sql"), SQL);
  console.log("wrote data/seed.json, data/seed-meta.json, supabase/migrations/001_articles.sql");

  if (toSupabase) await uploadToSupabase(seed);
  if (process.exitCode) console.error("DONE WITH MISMATCHES — do not cut over.");
  else console.log(`DONE: ${seed.length} rows, manifest total ${manifestTotal} — match.`);
}

async function uploadToSupabase(seed) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in env (never in this file).");
  const BATCH = 200;
  for (let i = 0; i < seed.length; i += BATCH) {
    const batch = seed.slice(i, i + BATCH).map(toDbRow);
    const r = await fetch(`${url}/rest/v1/articles?on_conflict=site,slug`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`Supabase insert batch ${i} failed: ${r.status} ${await r.text()}`);
    console.log(`uploaded ${Math.min(i + BATCH, seed.length)}/${seed.length}`);
  }
}

function toDbRow(a) {
  // Old schema: source is a plain string (134 rows) with no URL.
  const srcName = typeof a.source === "string" ? a.source : (a.source?.name || "");
  const srcUrl = typeof a.source === "string" ? (a.source_url || "") : (a.source?.url || a.source_url || "");
  return {
    site: a.site, slug: a.id, category: a.category, published_at: a.published_at,
    source_name: srcName, source_url: srcUrl,
    image_url: a.image_url || null, image_r2_key: a.image_r2_key || null,
    image_caption: a.image_caption || null, footer_note: a.footer_note || null,
    title_en: a.title?.en || "", title_zh_hant: a.title?.zh_hant || "", title_zh_hans: a.title?.zh_hans || "",
    summary_en: a.summary?.en || "", summary_zh_hant: a.summary?.zh_hant || "", summary_zh_hans: a.summary?.zh_hans || "",
    tags_en: a.tags?.en || [], tags_zh_hant: a.tags?.zh_hant || [], tags_zh_hans: a.tags?.zh_hans || [],
    status: "published",
  };
}

const SQL = `-- hkcn-news articles table — run once in Supabase Dashboard → SQL Editor.
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
`;

main().catch((e) => { console.error(e); process.exit(1); });
