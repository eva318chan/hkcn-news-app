// /api/admin/articles — article management (Google SSO admin session only).
//   GET    ?page=&limit=&q=&status=        list, all statuses, newest first
//   GET    ?id=<slug>                       one article (any status)
//   PATCH  ?id=<slug>  {title_*, summary_*, tags_*, category, image_url,
//                       image_r2_key, image_caption, footer_note, status}
//   DELETE ?id=<slug>                       delete (the UI confirms first)
// Editable text is title_*/summary_* in en/zh_hant/zh_hans — articles have
// no full body column; the article page renders the summary as its content.
// Writes return 503 in seed mode (no database to write to).
"use strict";
const { requireAdmin } = require("../../lib/admin-auth");
const {
  dbConfigured, adminListArticles, getArticleAdmin, updateArticle, deleteArticle,
} = require("../../lib/data");

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const LANGS = ["en", "zh_hant", "zh_hans"];
const CATEGORIES = new Set([
  "world", "china", "hongkong", "taiwan", "finance", "tech",
  "sports", "entertainment", "health", "education", "other",
]);

// Only real articles columns, with the right shape — nothing else reaches the DB.
function cleanPatch(body) {
  if (!body || typeof body !== "object") return null;
  const patch = {};
  for (const lang of LANGS) {
    if (body[`title_${lang}`] !== undefined) {
      if (typeof body[`title_${lang}`] !== "string") return { error: `title_${lang} must be a string` };
      patch[`title_${lang}`] = body[`title_${lang}`].slice(0, 500);
    }
    if (body[`summary_${lang}`] !== undefined) {
      if (typeof body[`summary_${lang}`] !== "string") return { error: `summary_${lang} must be a string` };
      patch[`summary_${lang}`] = body[`summary_${lang}`].slice(0, 5000);
    }
    if (body[`tags_${lang}`] !== undefined) {
      if (!Array.isArray(body[`tags_${lang}`]) || body[`tags_${lang}`].some((t) => typeof t !== "string")) {
        return { error: `tags_${lang} must be an array of strings` };
      }
      patch[`tags_${lang}`] = body[`tags_${lang}`].map((t) => t.trim()).filter(Boolean).slice(0, 30);
    }
  }
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !body.category.trim()) return { error: "category must be a non-empty string" };
    patch.category = body.category.trim().slice(0, 50);
  }
  if (body.image_url !== undefined) {
    if (body.image_url !== null && typeof body.image_url !== "string") return { error: "image_url must be a string or null" };
    patch.image_url = body.image_url ? body.image_url.trim().slice(0, 2000) : null;
  }
  if (body.image_r2_key !== undefined) {
    if (body.image_r2_key !== null && typeof body.image_r2_key !== "string") return { error: "image_r2_key must be a string or null" };
    patch.image_r2_key = body.image_r2_key ? body.image_r2_key.trim().slice(0, 500) : null;
  }
  if (body.image_caption !== undefined) {
    if (body.image_caption !== null && typeof body.image_caption !== "string") return { error: "image_caption must be a string or null" };
    patch.image_caption = body.image_caption ? body.image_caption.slice(0, 1000) : null;
  }
  if (body.footer_note !== undefined) {
    if (body.footer_note !== null && typeof body.footer_note !== "string") return { error: "footer_note must be a string or null" };
    patch.footer_note = body.footer_note ? body.footer_note.slice(0, 1000) : null;
  }
  if (body.status !== undefined) {
    if (body.status !== "published" && body.status !== "draft") return { error: "status must be published or draft" };
    patch.status = body.status;
  }
  if (Object.keys(patch).length === 0) return { error: "nothing to update" };
  return { patch };
}

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = req.query || {};
  const slug = String(q.id || "").trim();

  try {
    if (req.method === "GET") {
      if (slug) {
        const a = await getArticleAdmin(slug);
        if (!a) { res.status(404).json({ ok: false, error: "not found" }); return; }
        res.status(200).json({ ok: true, article: a });
        return;
      }
      const out = await adminListArticles({
        page: q.page, limit: q.limit,
        q: (q.q || "").trim(),
        status: (q.status || "").trim(),
      });
      res.status(200).json({ ok: true, ...out });
      return;
    }

    if (req.method === "PATCH") {
      if (!slug) { res.status(400).json({ ok: false, error: "missing id" }); return; }
      if (!dbConfigured) { res.status(503).json({ ok: false, error: "database not configured" }); return; }
      let body;
      try { body = await readBody(req); }
      catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
      const cleaned = cleanPatch(body);
      if (cleaned.error) { res.status(400).json({ ok: false, error: cleaned.error }); return; }
      const updated = await updateArticle(slug, cleaned.patch);
      if (!updated) { res.status(404).json({ ok: false, error: "not found" }); return; }
      res.status(200).json({ ok: true, article: updated });
      return;
    }

    if (req.method === "DELETE") {
      if (!slug) { res.status(400).json({ ok: false, error: "missing id" }); return; }
      if (!dbConfigured) { res.status(503).json({ ok: false, error: "database not configured" }); return; }
      const existing = await getArticleAdmin(slug);
      if (!existing) { res.status(404).json({ ok: false, error: "not found" }); return; }
      await deleteArticle(slug);
      res.status(200).json({ ok: true, deleted: slug });
      return;
    }

    res.setHeader("Allow", "GET, PATCH, DELETE");
    res.status(405).json({ ok: false, error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
