// Data layer for hkcn-news-app — one seam, two backends.
//   * Supabase Postgres when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (server-side only).
//   * Bundled seed data (data/seed.json, snapshot of the live static repo) otherwise.
// Swapping seed -> real DB/R2 is env-only, no code change.
// Images: R2 public URL (R2_PUBLIC_BASE_URL) when configured, else the local
// /design/202611/ copy in this repo, else the original image_url (hotlink).
// No secrets in this file. Nothing here runs in the browser.
"use strict";

const SITE = "hkcn";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const R2_BASE = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

const dbConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);
const r2Configured = Boolean(R2_BASE);

let seedCache = null;
function loadSeed() {
  if (!seedCache) {
    seedCache = require("../../data/seed.json");
    seedCache.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
  }
  return seedCache;
}

let metaCache = null;
function loadSeedMeta() {
  if (!metaCache) metaCache = require("../../data/seed-meta.json");
  return metaCache;
}

// Old-site design images live at /assets/design/<file> (hkcnexpress.com or
// hkcn-news.vercel.app). In this app they are served from /design/202611/<file>
// until R2 is configured, then from <R2_BASE>/design/202611/<file>.
function resolveImage(a) {
  const url = a.image_url || "";
  const key = a.image_r2_key || "";
  if (key && r2Configured) return `${R2_BASE}/${key}`;
  if (key) return `/design/202611/${key.split("/").pop()}`;
  const m = url.match(/\/assets\/design\/([^/?#]+\.jpg)$/i);
  if (m) {
    if (r2Configured) return `${R2_BASE}/design/202611/${m[1]}`;
    return `/design/202611/${m[1]}`;
  }
  return url;
}

// Public shape — identical to the old data/*.json shape, plus caption/footer
// extras that used to live only in the static HTML.
function toPublic(a) {
  const out = {
    id: a.id || a.slug,
    category: a.category,
    published_at: a.published_at,
    source: a.source || { name: a.source_name || "", url: a.source_url || "" },
    image_url: resolveImage(a),
    title: a.title || { en: a.title_en || "", zh_hant: a.title_zh_hant || "", zh_hans: a.title_zh_hans || "" },
    summary: a.summary || { en: a.summary_en || "", zh_hant: a.summary_zh_hant || "", zh_hans: a.summary_zh_hans || "" },
    tags: a.tags || { en: a.tags_en || [], zh_hant: a.tags_zh_hant || [], zh_hans: a.tags_zh_hans || [] },
  };
  if (a.image_caption) out.image_caption = a.image_caption;
  if (a.footer_note) out.footer_note = a.footer_note;
  return out;
}

function fromDbRow(r) {
  return {
    id: r.slug, slug: r.slug, category: r.category, published_at: r.published_at,
    source_name: r.source_name, source_url: r.source_url,
    image_url: r.image_url, image_r2_key: r.image_r2_key,
    image_caption: r.image_caption, footer_note: r.footer_note,
    title_en: r.title_en, title_zh_hant: r.title_zh_hant, title_zh_hans: r.title_zh_hans,
    summary_en: r.summary_en, summary_zh_hant: r.summary_zh_hant, summary_zh_hans: r.summary_zh_hans,
    tags_en: r.tags_en, tags_zh_hant: r.tags_zh_hant, tags_zh_hans: r.tags_zh_hans,
  };
}

async function sbFetch(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Fetch published rows for this site, with server-side filters where PostgREST
// can express them. Bounded (cap 2000) — final sort/pagination happens in JS
// so seed and Supabase behave identically.
async function fetchRows({ category, date, tag, q }) {
  if (!dbConfigured) {
    return loadSeed().filter((a) => a.site === SITE || !a.site);
  }
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("site", `eq.${SITE}`);
  params.set("status", "eq.published");
  if (category) params.set("category", `eq.${category}`);
  if (date) {
    // One `and=(...)` group so the day window is exact (a plain repeated
    // param would be ambiguous). JS re-applies the same filter below.
    params.set("and", `(published_at.gte.${date}T00:00:00+08:00,published_at.lt.${date}T23:59:59+08:00)`);
  }
  if (tag) {
    params.set("or", `(tags_zh_hant.cs.{${tag}},tags_en.cs.{${tag}},tags_zh_hans.cs.{${tag}})`);
  }
  if (q) {
    const like = `*${q}*`;
    params.set("or", `(title_zh_hant.ilike.${like},title_en.ilike.${like},summary_zh_hant.ilike.${like},summary_en.ilike.${like},source_name.ilike.${like})`);
  }
  params.set("order", "published_at.desc");
  params.set("limit", "2000");
  const rows = await sbFetch(`articles?${params.toString()}`);
  return rows.map(fromDbRow);
}

// 11 old rows have tags as a plain list (not {en, zh_hant, zh_hans}) and 134
// have source as a plain string. Both shapes must keep working.
function allTags(a) {
  if (Array.isArray(a.tags)) return a.tags;
  return [...(a.tags?.en || []), ...(a.tags?.zh_hant || []), ...(a.tags?.zh_hans || []),
    ...(a.tags_en || []), ...(a.tags_zh_hant || []), ...(a.tags_zh_hans || [])];
}

function matches(a, { category, date, tag, q }) {
  if (category && a.category !== category) return false;
  if (date && !(a.published_at || "").startsWith(date)) return false;
  if (tag && !allTags(a).includes(tag)) return false;
  if (q) {
    const needle = q.toLowerCase();
    const hay = [
      a.title?.en, a.title?.zh_hant, a.title?.zh_hans,
      a.summary?.en, a.summary?.zh_hant, a.summary?.zh_hans,
      a.title_en, a.title_zh_hant, a.title_zh_hans,
      a.summary_en, a.summary_zh_hant, a.summary_zh_hans,
      typeof a.source === "string" ? a.source : a.source?.name, a.source_name,
      ...allTags(a),
    ].join(" ").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// Live homepage order is published_at DESC (assets/app.js re-sorts everything
// that way). Rule 5C image-first ordering lives in the daily JSON files, but
// the live homepage does NOT show it — see README. Default sort therefore
// matches the live site; ?sort=image_first gives the 5C order explicitly.
function sortRows(rows, sort) {
  const byDate = (a, b) => (b.published_at || "").localeCompare(a.published_at || "");
  if (sort === "image_first") {
    const withImg = rows.filter((a) => (a.image_url || "").trim() !== "").sort(byDate);
    const without = rows.filter((a) => !(a.image_url || "").trim()).sort(byDate);
    return [...withImg, ...without];
  }
  return [...rows].sort(byDate);
}

async function listArticles(opts = {}) {
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 30));
  const rows = await fetchRows(opts);
  const filtered = rows.filter((a) => matches(a, opts));
  const sorted = sortRows(filtered, opts.sort);
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const slice = sorted.slice((page - 1) * limit, page * limit);
  return { total, page, limit, pages, articles: slice.map(toPublic) };
}

async function getArticle(slug) {
  if (!slug) return null;
  if (!dbConfigured) {
    const a = loadSeed().find((x) => x.id === slug);
    return a ? toPublic(a) : null;
  }
  const rows = await sbFetch(`articles?select=*&site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}&status=eq.published&limit=1`);
  return rows.length ? toPublic(fromDbRow(rows[0])) : null;
}

async function getMeta() {
  if (!dbConfigured) {
    const m = loadSeedMeta();
    return { updated_at: m.updated_at, dates: m.dates, total: m.total, source: "seed" };
  }
  try {
    const r = await sbFetch("rpc/articles_meta");
    return { updated_at: r.updated_at, dates: r.dates, total: r.total, source: "supabase" };
  } catch (e) {
    // RPC not installed yet — fall back to counting from a bounded fetch.
    const rows = await fetchRows({});
    const counts = {};
    for (const a of rows) counts[(a.published_at || "").slice(0, 10)] = (counts[(a.published_at || "").slice(0, 10)] || 0) + 1;
    const dates = Object.keys(counts).sort().reverse().map((d) => ({ date: d, count: counts[d] }));
    return { updated_at: rows[0]?.published_at || "", dates, total: rows.length, source: "supabase (no rpc)" };
  }
}

function siteUrl(req) {
  if (SITE_URL) return SITE_URL;
  const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "";
  const proto = (req.headers && req.headers["x-forwarded-proto"]) || "https";
  return host ? `${proto}://${host}` : "https://hkcnexpress.com";
}

function setCache(res, seconds) {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=300`);
}

module.exports = {
  SITE, dbConfigured, r2Configured, listArticles, getArticle, getMeta,
  toPublic, resolveImage, siteUrl, setCache,
};
