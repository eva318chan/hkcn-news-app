// POST /api/ingest — the publishing endpoint used by the Bella pipeline.
//   Headers: x-ingest-secret: <INGEST_SECRET env var>
//   Body (one article, same shape as the old data/*.json entries):
//     { id, category, published_at, source:{name,url}, image_url,
//       image_r2_key?, image_caption?, footer_note?, image_prompt?,
//       extra_images?,
//       title:{en,zh_hant,zh_hans}, summary:{en,zh_hant,zh_hans},
//       tags:{en,zh_hant,zh_hans} }
//   extra_images is an optional array of {url, caption} for additional real
//   photos, rendered below the summary (migration 003). The hero image stays
//   in image_url / image_caption.
//   image_prompt is the exact Gemini prompt used to generate the article's
//   AI design image (migration 002). It is stored in articles.image_prompt;
//   null/absent for real photos, hotlinks and pre-migration articles. The
//   POST response echoes the value actually stored, so the pipeline can
//   verify the prompt round-tripped to the DB.
//   Dedupes by (site, slug): re-posting the same id updates it, never duplicates.
//   DELETE /api/ingest?slug=<id> — removes one article (same secret; used to
//   clean up test inserts).
// Without INGEST_SECRET configured this returns 503. Without Supabase
// configured it returns 503 after auth — there is nowhere to store the row,
// and staging must never pretend an insert succeeded.
"use strict";

const SITE = "hkcn";

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

function toDbRow(a) {
  // Old schema: source may be a plain string with no URL.
  const srcName = typeof a.source === "string" ? a.source : (a.source?.name || "");
  const srcUrl = typeof a.source === "string" ? (a.source_url || "") : (a.source?.url || a.source_url || "");
  return {
    site: SITE,
    slug: a.id,
    category: a.category,
    published_at: a.published_at,
    source_name: srcName,
    source_url: srcUrl,
    image_url: a.image_url || null,
    image_r2_key: a.image_r2_key || null,
    image_caption: a.image_caption || null,
    footer_note: a.footer_note || null,
    // Only sent when a prompt is supplied: the column is added by migration
    // 002, and sending the key before 002 is applied would fail the upsert.
    // Absent prompt => the column keeps its default (null).
    ...(a.image_prompt ? { image_prompt: a.image_prompt } : {}),
    // Same rule as image_prompt: extra_images needs migration 003 applied
    // before it can be sent, or the upsert fails on the unknown column.
    ...(a.extra_images ? { extra_images: a.extra_images } : {}),
    title_en: a.title?.en || "",
    title_zh_hant: a.title?.zh_hant || "",
    title_zh_hans: a.title?.zh_hans || "",
    summary_en: a.summary?.en || "",
    summary_zh_hant: a.summary?.zh_hant || "",
    summary_zh_hans: a.summary?.zh_hans || "",
    tags_en: a.tags?.en || [],
    tags_zh_hant: a.tags?.zh_hant || [],
    tags_zh_hans: a.tags?.zh_hans || [],
    status: "published",
  };
}

function validate(a) {
  if (!a || typeof a !== "object") return "body must be an object";
  if (!a.id || typeof a.id !== "string") return "missing id";
  if (!/^\d{8}-[a-z0-9-]+$/.test(a.id)) return "id must look like YYYYMMDD-slug";
  if (!a.category) return "missing category";
  if (!a.published_at || Number.isNaN(Date.parse(a.published_at))) return "missing/invalid published_at";
  if (!a.title?.zh_hant && !a.title?.en) return "missing title";
  if (!a.summary?.zh_hant && !a.summary?.en) return "missing summary";
  if (a.extra_images !== undefined) {
    if (!Array.isArray(a.extra_images) || a.extra_images.length > 10) {
      return "extra_images must be an array of at most 10 items";
    }
    for (const e of a.extra_images) {
      if (!e || typeof e !== "object" || typeof e.url !== "string" ||
          !/^https?:\/\//.test(e.url) ||
          (e.caption !== undefined && typeof e.caption !== "string")) {
        return "each extra_images item needs a url (http(s)) and an optional caption string";
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  const secret = process.env.INGEST_SECRET || "";
  if (!secret) {
    res.status(503).json({ ok: false, error: "ingest not configured: INGEST_SECRET is not set" });
    return;
  }
  const given = req.headers["x-ingest-secret"] || "";
  if (given !== secret) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  const sbUrl = process.env.SUPABASE_URL || "";
  const sbKey = process.env.SUPABASE_SERVICE_KEY || "";
  if (!sbUrl || !sbKey) {
    res.status(503).json({ ok: false, error: "database not configured: SUPABASE_URL / SUPABASE_SERVICE_KEY are not set" });
    return;
  }
  const headers = {
    apikey: sbKey, Authorization: `Bearer ${sbKey}`,
    "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
  };

  try {
    if (req.method === "DELETE") {
      const slug = String((req.query || {}).slug || "").trim();
      if (!slug) { res.status(400).json({ ok: false, error: "missing slug" }); return; }
      const r = await fetch(`${sbUrl}/rest/v1/articles?site=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}`, {
        method: "DELETE", headers,
      });
      if (!r.ok) { res.status(502).json({ ok: false, error: `database error ${r.status}` }); return; }
      res.status(200).json({ ok: true, deleted: slug });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, DELETE");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    const err = validate(body);
    if (err) { res.status(400).json({ ok: false, error: err }); return; }
    const r = await fetch(`${sbUrl}/rest/v1/articles?on_conflict=site,slug`, {
      method: "POST", headers, body: JSON.stringify(toDbRow(body)),
    });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `database error ${r.status}: ${(await r.text()).slice(0, 200)}` });
      return;
    }
    // Confirm what is actually stored, not just what was sent — the
    // pipeline uses this to verify image_prompt round-tripped to the DB.
    let storedPrompt = null;
    try {
      const vr = await fetch(`${sbUrl}/rest/v1/articles?select=image_prompt&site=eq.${SITE}&slug=eq.${encodeURIComponent(body.id)}&limit=1`, { headers });
      if (vr.ok) {
        const vrows = await vr.json();
        if (Array.isArray(vrows) && vrows.length) storedPrompt = vrows[0].image_prompt ?? null;
      }
    } catch (e) { /* read-back failed — the insert itself already succeeded */ }
    res.status(200).json({ ok: true, slug: body.id, url: `/a/${body.id}.html`, image_prompt: storedPrompt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
