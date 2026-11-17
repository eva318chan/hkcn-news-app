// GET /sitemap.xml — generated live from the article store (was a static file
// rebuilt by push_feeds.py on every publish). Same shape as the live sitemap:
// homepage + one <url> per published article, lastmod = publish date.
//
// GET /news-sitemap.xml — the same function (?news=1 via the vercel.json
// rewrite): a Google News sitemap, only articles from the last 48 hours with
// <news:news> (publication name must match the Publisher Center publication
// "中港新聞速報"; language zh-tw = Traditional Chinese, the only zh-Hant
// option Publisher Center offers). No new function: the app is at the
// 12-function Hobby limit, so the news sitemap shares this function.
"use strict";
const { listArticles, siteUrl, setCache } = require("../lib/data");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// lastmod is the Hong Kong publish date. published_at is an instant (UTC from
// Supabase), so slicing the raw string would give the previous day for
// early-morning Hong Kong articles.
function hktDate(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 10);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// News sitemap publication_date: W3C datetime in Hong Kong time.
function hktDateTime(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 19) + "+08:00";
  const hkt = new Date(d.getTime() + 8 * 3600 * 1000);
  return hkt.toISOString().slice(0, 19) + "+08:00";
}

const NEWS_NAME = "中港新聞速報";
const NEWS_LANG = "zh-tw";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).send("method not allowed");
    return;
  }
  try {
    if (req.query && req.query.news) {
      // Google News sitemap: last 48 hours only. listArticles sorts
      // published_at DESC, so page 1 (100 newest) always covers the window.
      const cutoff = Date.now() - 48 * 3600 * 1000;
      const { articles } = await listArticles({ limit: 100, page: 1 });
      const recent = articles
        .filter((a) => a.published_at && new Date(a.published_at).getTime() >= cutoff)
        .slice(0, 1000);
      const base = siteUrl(req);
      const urls = recent.map((a) => {
        const title = (a.title && (a.title.zh_hant || a.title.zh_hans || a.title.en)) || a.id;
        return `  <url><loc>${esc(base)}/a/${esc(a.id)}.html</loc><news:news><news:publication><news:name>${esc(NEWS_NAME)}</news:name><news:language>${NEWS_LANG}</news:language></news:publication><news:publication_date>${esc(hktDateTime(a.published_at))}</news:publication_date><news:title>${esc(title)}</news:title></news:news></url>`;
      });
      setCache(res, 60);
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${urls.join("\n")}\n</urlset>`);
      return;
    }
    const { articles, total } = await listArticles({ limit: 100, page: 1 });
    // listArticles caps limit at 100; page through the rest for the sitemap.
    let all = [...articles];
    const pages = Math.ceil(total / 100);
    for (let p = 2; p <= pages; p++) {
      const r = await listArticles({ limit: 100, page: p });
      all = all.concat(r.articles);
    }
    const base = siteUrl(req);
    const urls = [`  <url><loc>${esc(base)}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`];
    for (const a of all) {
      urls.push(`  <url><loc>${esc(base)}/a/${esc(a.id)}.html</loc><lastmod>${esc(hktDate(a.published_at))}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`);
    }
    setCache(res, 600);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`);
  } catch (e) {
    res.status(500).send(String(e.message || e).slice(0, 200));
  }
};
