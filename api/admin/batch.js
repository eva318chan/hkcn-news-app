// POST /api/admin/batch — Gemini Batch API image generation (admin only).
//   One endpoint for the whole batch flow. Vercel Hobby allows 12 serverless
//   functions per deployment and this is #12, so every batch action lives
//   here behind an `action` field in the POST body (the same pattern as the
//   logout branch of /api/admin/auth/callback). Every action needs the Google
//   SSO admin session (lib/admin-auth requireAdmin); the Gemini key never
//   leaves the server and is never returned or logged.
//   Actions (POST body { action, ... }):
//     list-articles { dateFrom, dateTo, image }  articles in a date range
//     create        { slugs, model }             submit a Gemini batch (max 10)
//     check         { batchId }                  poll Gemini; download results to R2 staging
//     approve       { itemIds }                  copy staging image to design/ + link article
//     reject        { itemIds }                  delete staging image, mark rejected
//     list-batches  { page, limit }              batches + per-status counts
//     list-items    { status, batchId }          batch items (the review list)
//     stats         {}                           per-model generated + cost + model prices
//   DB tables (sql/001-batch-tables.sql — run once in the Supabase SQL
//   Editor): image_batches, image_batch_items, gemini_model_prices.
//   Nothing here auto-generates, auto-checks or auto-publishes: the admin
//   clicks Generate / Check / Approve for every step, and the user is the
//   control for the whole flow (2026-11-13 decision). Step 5D (immediate
//   image generation in the pipeline) is PAUSED — this batch flow is the
//   only image-generation path now.
//   Gemini Batch API (verified 2026-11-13 against ai.google.dev):
//     create: POST /v1beta/models/{model}:batchGenerateContent
//             { batch: { display_name, input_config: { requests: { requests:
//               [{ request: { contents, generationConfig }, metadata: { key } }] } } } }
//             -> { name: "batches/xxx", ... }
//     check:  GET  /v1beta/batches/{id}
//             -> { done, metadata: { state: JOB_STATE_* },
//                  response: { inlinedResponses: [{ response | error }] } }
//             Responses are in request order (metadata.key is the slug, kept
//             for traceability). A finished batch does NOT guarantee a usable
//             image for every request — per-item failures are recorded.
//   Batch price is half of standard (Lite ~$0.017, Flash 1K ~$0.034,
//   Pro 1K/2K ~$0.067 per image). Target turnaround is up to 24h.
"use strict";
const { requireAdmin } = require("../../lib/admin-auth");
const { r2Configured, r2PublicBase, putObject, copyObject, deleteObject } = require("../../lib/r2");

const SITE = "hkcn";
const MAX_BATCH = 10;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const STAGING_PREFIX = "staging/design";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TABLES_MISSING = "batch tables are not created yet — run sql/001-batch-tables.sql in the Supabase SQL Editor, then try again";

// Verified 2026-11-13 (Google pricing page): batch price is half of standard.
// Used when the gemini_model_prices table is empty or not yet created, so the
// model picker still works before the SQL is run. Do NOT offer
// gemini-2.5-flash-image — it retires 2027-03-15.
const FALLBACK_MODELS = [
  { model: "gemini-3.1-flash-lite-image", display_name: "Lite (Nano Banana 2 Lite)", standard_price_usd: 0.0336, batch_price_usd: 0.0168 },
  { model: "gemini-3.1-flash-image", display_name: "Flash Image (Nano Banana 2) — 1K", standard_price_usd: 0.067, batch_price_usd: 0.034 },
  { model: "gemini-3-pro-image", display_name: "Pro Image (Nano Banana Pro) — 1K/2K", standard_price_usd: 0.134, batch_price_usd: 0.067 },
];

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

function hktToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nextDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return date;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)).toISOString().slice(0, 10);
}

// Hong Kong year-month (YYYYMM) of a published_at instant — the design/
// folder convention is monthly by article date.
function hktYearMonth(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return hktToday().slice(0, 7).replace("-", "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7).replace("-", "");
}

function round2(n) { return Math.round(n * 100) / 100; }

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- Supabase (service key, server-side only) ----

function sbEnv() {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_KEY || "";
  if (!url || !key) throw err(503, "database not configured: SUPABASE_URL / SUPABASE_SERVICE_KEY are not set");
  return { url, key };
}

function isMissingTable(e) {
  return Boolean(e && (e.code === "PGRST205" || /Could not find the table/i.test(String(e.message || ""))));
}

async function sbFetch(path, { method = "GET", body, prefer } = {}) {
  const { url, key } = sbEnv();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain-text error */ }
  if (!r.ok) {
    const msg = (json && (json.message || json.error)) || text || `HTTP ${r.status}`;
    const e = new Error(String(msg).slice(0, 300));
    e.status = r.status;
    e.code = json && json.code;
    throw e;
  }
  return { json, headers: r.headers };
}

async function sbRows(path, opts) {
  const { json } = await sbFetch(path, opts);
  return Array.isArray(json) ? json : [];
}

function totalFromHeaders(headers) {
  const m = (headers.get("content-range") || "").match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- Gemini Batch API (key from env, never in the repo or a response) ----

function geminiKey() {
  const k = process.env.GEMINI_API_KEY || "";
  if (!k) throw err(503, "GEMINI_API_KEY is not set — set it in Vercel → hkcn-news-app → Environment Variables, then redeploy");
  return k;
}

async function geminiJson(url, { method = "GET", body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { "x-goog-api-key": geminiKey(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* plain-text error */ }
  if (!r.ok) {
    const msg = (json && json.error && (json.error.message || JSON.stringify(json.error))) || text || `HTTP ${r.status}`;
    throw err(502, `Gemini ${r.status}: ${String(msg).slice(0, 300)}`);
  }
  return json || {};
}

// Create a batch job. `requests` is [{ key (slug), prompt }]. The request
// shape mirrors the verified single-image call (bin/gemini.py): text prompt
// + responseModalities TEXT+IMAGE + 16:9 aspect ratio.
async function geminiCreateBatch({ model, displayName, requests }) {
  return geminiJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:batchGenerateContent`, {
    method: "POST",
    body: {
      batch: {
        display_name: displayName,
        input_config: {
          requests: {
            requests: requests.map((req) => ({
              request: {
                contents: [{ role: "user", parts: [{ text: req.prompt }] }],
                generationConfig: {
                  responseModalities: ["TEXT", "IMAGE"],
                  imageConfig: { aspectRatio: "16:9" },
                },
              },
              metadata: { key: req.key },
            })),
          },
        },
      },
    },
  });
}

async function geminiGetBatch(name) {
  if (!/^batches\/[A-Za-z0-9_-]+$/.test(name)) throw err(400, `invalid batch name: ${name}`);
  return geminiJson(`${GEMINI_BASE}/${name}`);
}

const GEMINI_STATE = {
  JOB_STATE_PENDING: "pending",
  JOB_STATE_RUNNING: "running",
  JOB_STATE_SUCCEEDED: "succeeded",
  JOB_STATE_FAILED: "failed",
  JOB_STATE_CANCELLED: "cancelled",
  JOB_STATE_EXPIRED: "expired",
};

function geminiState(job) {
  const raw = (job && job.metadata && job.metadata.state) || (job && job.state) || "";
  if (GEMINI_STATE[raw]) return GEMINI_STATE[raw];
  return raw ? String(raw).replace(/^JOB_STATE_/, "").toLowerCase() : "pending";
}

// ---- Model prices (DB table, with the verified fallback) ----

async function loadModels() {
  try {
    const rows = await sbRows("gemini_model_prices?select=*&order=model.asc");
    if (rows.length) {
      return {
        models: rows.map((r) => ({
          model: r.model, display_name: r.display_name,
          standard_price_usd: Number(r.standard_price_usd), batch_price_usd: Number(r.batch_price_usd),
        })),
        source: "db", tablesMissing: false,
      };
    }
    return { models: FALLBACK_MODELS.map((m) => ({ ...m })), source: "fallback", tablesMissing: false };
  } catch (e) {
    // Prices are a read-only summary: fall back instead of failing the page.
    return { models: FALLBACK_MODELS.map((m) => ({ ...m })), source: "fallback", tablesMissing: isMissingTable(e) };
  }
}

// ---- Public shapes ----

function stagingUrl(key) {
  const base = r2PublicBase();
  return key && base ? `${base}/${key}` : null;
}

function publicBatch(b, items) {
  const counts = { submitted: 0, generated: 0, approved: 0, rejected: 0, failed: 0 };
  for (const it of items || []) if (counts[it.status] !== undefined) counts[it.status]++;
  return {
    id: b.id, gemini_batch_name: b.gemini_batch_name, model: b.model, status: b.status,
    created_at: b.created_at, created_by: b.created_by, article_count: b.article_count, counts,
  };
}

function publicItem(it, extra) {
  return {
    id: it.id, batch_id: it.batch_id, article_slug: it.article_slug, status: it.status,
    staging_r2_key: it.staging_r2_key || null, staging_url: stagingUrl(it.staging_r2_key),
    error: it.error || null, ...(extra || {}),
  };
}

// ---- Actions ----

// Articles in a date range (Hong Kong days). Default: today, without-image
// only. Published articles only — drafts do not get batch images.
async function listArticles(body) {
  const today = hktToday();
  const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(body.dateFrom || "") ? body.dateFrom : today;
  const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(body.dateTo || "") ? body.dateTo : today;
  const image = body.image === "all" ? "all" : "without";
  const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 100));
  const params = new URLSearchParams();
  params.set("select", "slug,category,published_at,image_url,image_prompt,title_zh_hant,title_en");
  params.set("site", `eq.${SITE}`);
  params.set("status", "eq.published");
  params.set("published_at", `gte.${dateFrom}T00:00:00+08:00`);
  params.append("published_at", `lt.${nextDay(dateTo)}T00:00:00+08:00`);
  if (image === "without") params.set("or", "(image_url.is.null,image_url.eq.)");
  params.set("order", "published_at.desc,slug.asc");
  params.set("limit", String(limit));
  const { json, headers } = await sbFetch(`articles?${params.toString()}`, { prefer: "count=exact" });
  const rows = Array.isArray(json) ? json : [];
  return {
    ok: true, dateFrom, dateTo, image, total: totalFromHeaders(headers) ?? rows.length,
    articles: rows.map((a) => ({
      slug: a.slug, category: a.category, published_at: a.published_at,
      image_url: a.image_url || null, image_prompt: a.image_prompt || null,
      title_zh_hant: a.title_zh_hant || "", title_en: a.title_en || "",
    })),
  };
}

async function createBatch(body, email) {
  const slugs = Array.isArray(body.slugs)
    ? [...new Set(body.slugs.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!slugs.length) throw err(400, "select at least one article");
  if (slugs.length > MAX_BATCH) {
    throw err(400, `最多 ${MAX_BATCH} 篇一批：你揀咗 ${slugs.length} 篇，請減少選擇後再試`);
  }
  const { models } = await loadModels();
  const model = String(body.model || "").trim();
  if (!models.some((m) => m.model === model)) {
    throw err(400, `unknown model: ${model || "(none)"} — pick one from the model list`);
  }
  // Validate the articles BEFORE calling Gemini, so a bad selection costs nothing.
  const rows = await sbRows(`articles?select=slug,image_url,image_prompt&site=eq.${SITE}&slug=in.(${slugs.map(encodeURIComponent).join(",")})`);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const bad = [];
  for (const slug of slugs) {
    const a = bySlug.get(slug);
    if (!a) bad.push(`${slug}：搵唔到呢篇文章`);
    else if (!(a.image_prompt || "").trim()) bad.push(`${slug}：未有 image_prompt，請先準備 prompt`);
    else if ((a.image_url || "").trim()) bad.push(`${slug}：已經有圖，唔使再生`);
  }
  if (bad.length) throw err(400, `以下文章唔可以直接入 batch：\n${bad.join("\n")}`);
  const displayName = `hkcn-batch-${hktToday().replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const job = await geminiCreateBatch({
    model, displayName,
    requests: slugs.map((slug) => ({ key: slug, prompt: bySlug.get(slug).image_prompt.trim() })),
  });
  const geminiName = job && job.name;
  if (!geminiName || !/^batches\/[A-Za-z0-9_-]+$/.test(geminiName)) {
    throw err(502, `Gemini did not return a batch name: ${JSON.stringify(job).slice(0, 200)}`);
  }
  const state = geminiState(job);
  let batchRow = null;
  try {
    const created = await sbFetch("image_batches", {
      method: "POST", prefer: "return=representation",
      body: { gemini_batch_name: geminiName, model, status: state, created_by: email || null, article_count: slugs.length },
    });
    batchRow = Array.isArray(created.json) && created.json.length ? created.json[0] : null;
    if (!batchRow || !batchRow.id) throw new Error("database did not return the created batch");
    const items = await sbFetch("image_batch_items", {
      method: "POST", prefer: "return=representation",
      body: slugs.map((slug) => ({ batch_id: batchRow.id, article_slug: slug, status: "submitted" })),
    });
    const itemRows = Array.isArray(items.json) ? items.json : [];
    return { ok: true, batch: publicBatch(batchRow, itemRows), items: itemRows.map((it) => publicItem(it)), gemini_batch_name: geminiName };
  } catch (e) {
    // The Gemini batch already exists — remove the half-saved DB rows so a
    // retry does not leave an orphan, and surface the Gemini batch name so
    // it can still be recovered by hand.
    if (batchRow && batchRow.id) {
      try { await sbFetch(`image_batches?id=eq.${batchRow.id}`, { method: "DELETE" }); } catch (e2) { /* keep the original error */ }
    }
    if (isMissingTable(e)) throw e;
    throw err(502, `batch created on Gemini (${geminiName}) but could not be saved: ${String(e.message || e).slice(0, 200)}`);
  }
}

async function checkBatch(body) {
  const batchId = String(body.batchId || "").trim();
  if (!batchId) throw err(400, "missing batchId");
  const brows = await sbRows(`image_batches?select=*&id=eq.${encodeURIComponent(batchId)}&limit=1`);
  const batch = brows[0];
  if (!batch) throw err(404, "batch not found");
  const items = await sbRows(`image_batch_items?select=*&batch_id=eq.${encodeURIComponent(batchId)}&order=created_at.asc`);
  const terminal = new Set(["generated", "approved", "rejected", "failed"]);
  // Already finished and every item settled — return the stored state without
  // calling Gemini again (re-downloading would re-upload the same images).
  if (batch.status === "succeeded" && items.length && items.every((it) => terminal.has(it.status))) {
    return { ok: true, batch: publicBatch(batch, items), items: items.map((it) => publicItem(it)), note: "already complete — stored result returned" };
  }
  const job = await geminiGetBatch(batch.gemini_batch_name);
  const state = geminiState(job);
  const done = job.done === true || ["succeeded", "failed", "cancelled", "expired"].includes(state);
  const now = new Date().toISOString();
  if (!done) {
    await sbFetch(`image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: state, updated_at: now } });
    return { ok: true, batch: publicBatch({ ...batch, status: state }, items), items: items.map((it) => publicItem(it)), note: "batch still processing — check again later" };
  }
  if (state !== "succeeded") {
    const errMsg = (`batch ${state}` + (job.error && job.error.message ? `: ${String(job.error.message).slice(0, 200)}` : "")).slice(0, 500);
    for (const it of items) {
      if (it.status === "submitted") {
        await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: errMsg, updated_at: now } });
        it.status = "failed"; it.error = errMsg;
      }
    }
    await sbFetch(`image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: state, updated_at: now } });
    return { ok: true, batch: publicBatch({ ...batch, status: state }, items), items: items.map((it) => publicItem(it)), note: `batch ${state}` };
  }
  // Succeeded — download the results. Responses are in request order
  // (inlinedResponses[i] is the result of the i-th submitted article).
  if (!r2Configured()) throw err(503, "R2 credentials not configured — cannot download batch results");
  const responses = (job.response && job.response.inlinedResponses)
    || (job.dest && job.dest.inlinedResponses) || [];
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status !== "submitted") { results.push(publicItem(it)); continue; }
    const inline = responses[i];
    const resp = inline && inline.response;
    const errObj = inline && inline.error;
    let image = null;
    let failReason = null;
    if (errObj) {
      failReason = String(errObj.message || JSON.stringify(errObj)).slice(0, 300);
    } else if (!resp) {
      failReason = "no result in batch response";
    } else {
      const parts = ((resp.candidates || [])[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) { image = p.inlineData; break; }
      }
      if (!image) {
        const textPart = parts.find((p) => typeof p.text === "string" && p.text.trim());
        failReason = textPart
          ? `model returned text instead of an image: ${textPart.text.slice(0, 200)}`
          : "model returned no image";
      }
    }
    if (!image) {
      await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: failReason.slice(0, 500), updated_at: now } });
      results.push(publicItem({ ...it, status: "failed", error: failReason.slice(0, 500) }));
      continue;
    }
    const buf = Buffer.from(image.data, "base64");
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
      const reason = !buf.length ? "empty image data" : "image too large (max 10 MB)";
      await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "failed", error: reason, updated_at: now } });
      results.push(publicItem({ ...it, status: "failed", error: reason }));
      continue;
    }
    // Gemini output is saved as .jpg, same as the existing design/ files
    // (the bytes keep their real mime type in the R2 Content-Type).
    const key = `${STAGING_PREFIX}/${batchId}/${it.article_slug}.jpg`;
    const contentType = typeof image.mimeType === "string" && image.mimeType.startsWith("image/")
      ? image.mimeType : "image/jpeg";
    const out = await putObject({ key, body: buf, contentType });
    await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "generated", staging_r2_key: out.key, updated_at: now } });
    results.push(publicItem({ ...it, status: "generated", staging_r2_key: out.key }));
  }
  await sbFetch(`image_batches?id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", body: { status: "succeeded", updated_at: now } });
  const generated = results.filter((r) => r.status === "generated").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return {
    ok: true,
    batch: publicBatch({ ...batch, status: "succeeded" }, results.map((r) => ({ status: r.status }))),
    items: results,
    note: `downloaded ${generated} image(s), ${failed} failed — review them below before approving`,
  };
}

async function approveItems(body) {
  const ids = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!ids.length) throw err(400, "select at least one image to approve");
  if (!r2Configured()) throw err(503, "R2 credentials not configured");
  const results = [];
  for (const id of ids) {
    try {
      const rows = await sbRows(`image_batch_items?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const it = rows[0];
      if (!it) throw new Error("item not found");
      if (it.status !== "generated") throw new Error(`item is ${it.status}, not generated — nothing to approve`);
      if (!it.staging_r2_key) throw new Error("item has no staging image");
      const arows = await sbRows(`articles?select=slug,published_at&site=eq.${SITE}&slug=eq.${encodeURIComponent(it.article_slug)}&limit=1`);
      const article = arows[0];
      if (!article) throw new Error(`article ${it.article_slug} not found`);
      const destKey = `design/${hktYearMonth(article.published_at)}/${it.article_slug}.jpg`;
      const copied = await copyObject({ sourceKey: it.staging_r2_key, destKey });
      if (!copied.url) throw new Error("R2_PUBLIC_BASE_URL is not set — cannot build the public image URL");
      const now = new Date().toISOString();
      await sbFetch(`articles?site=eq.${SITE}&slug=eq.${encodeURIComponent(it.article_slug)}`, {
        method: "PATCH", body: { image_url: copied.url, image_r2_key: copied.key, updated_at: now },
      });
      await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "approved", updated_at: now } });
      try { await deleteObject(it.staging_r2_key); } catch (e) { /* staging cleanup is best-effort */ }
      results.push({ id: it.id, article_slug: it.article_slug, status: "approved", image_url: copied.url, image_r2_key: copied.key });
    } catch (e) {
      results.push({ id, article_slug: null, status: "error", error: String(e.message || e).slice(0, 200) });
    }
  }
  return { ok: true, results };
}

async function rejectItems(body) {
  const ids = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.map((s) => String(s).trim()).filter(Boolean))] : [];
  if (!ids.length) throw err(400, "select at least one image to reject");
  const results = [];
  for (const id of ids) {
    try {
      const rows = await sbRows(`image_batch_items?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const it = rows[0];
      if (!it) throw new Error("item not found");
      if (it.status !== "generated") throw new Error(`item is ${it.status}, not generated — nothing to reject`);
      if (it.staging_r2_key && r2Configured()) {
        try { await deleteObject(it.staging_r2_key); } catch (e) { /* best-effort */ }
      }
      await sbFetch(`image_batch_items?id=eq.${it.id}`, { method: "PATCH", body: { status: "rejected", updated_at: new Date().toISOString() } });
      results.push({ id: it.id, article_slug: it.article_slug, status: "rejected" });
    } catch (e) {
      results.push({ id, article_slug: null, status: "error", error: String(e.message || e).slice(0, 200) });
    }
  }
  return { ok: true, results };
}

async function listBatches(body) {
  const limit = Math.min(50, Math.max(1, parseInt(body.limit, 10) || 20));
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const offset = (page - 1) * limit;
  const { json, headers } = await sbFetch(
    `image_batches?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
    { prefer: "count=exact" },
  );
  const batches = Array.isArray(json) ? json : [];
  const ids = batches.map((b) => b.id);
  const itemsByBatch = {};
  if (ids.length) {
    const items = await sbRows(`image_batch_items?select=batch_id,status&batch_id=in.(${ids.join(",")})&limit=500`);
    for (const it of items) (itemsByBatch[it.batch_id] = itemsByBatch[it.batch_id] || []).push(it);
  }
  return {
    ok: true, total: totalFromHeaders(headers) ?? batches.length, page, limit,
    batches: batches.map((b) => publicBatch(b, itemsByBatch[b.id] || [])),
  };
}

async function listItems(body) {
  const status = String(body.status || "").trim();
  const batchId = String(body.batchId || "").trim();
  const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 50));
  const params = new URLSearchParams();
  params.set("select", "*,image_batches(model,gemini_batch_name,status)");
  if (status) params.set("status", `eq.${status}`);
  if (batchId) params.set("batch_id", `eq.${batchId}`);
  params.set("order", "created_at.desc");
  params.set("limit", String(limit));
  const items = await sbRows(`image_batch_items?${params.toString()}`);
  const slugs = [...new Set(items.map((it) => it.article_slug))];
  const titles = {};
  if (slugs.length) {
    const arows = await sbRows(`articles?select=slug,title_zh_hant,title_en&site=eq.${SITE}&slug=in.(${slugs.map(encodeURIComponent).join(",")})&limit=100`);
    for (const a of arows) titles[a.slug] = a.title_zh_hant || a.title_en || a.slug;
  }
  return {
    ok: true,
    items: items.map((it) => ({
      ...publicItem(it),
      title: titles[it.article_slug] || it.article_slug,
      model: (it.image_batches && it.image_batches.model) || null,
      gemini_batch_name: (it.image_batches && it.image_batches.gemini_batch_name) || null,
    })),
  };
}

// Usage stats. "Generated" counts every successful Gemini output (generated
// + approved + rejected) because each one was billed; cost is generated x
// the model's batch price. Never throws for a missing/empty price table —
// the model picker needs the fallback prices to work before the SQL is run.
async function stats() {
  const { models, source, tablesMissing } = await loadModels();
  const perModel = new Map();
  let itemsMissing = tablesMissing;
  if (!tablesMissing) {
    try {
      // Single page of 1000 — the same PostgREST cap lib/data.js pages
      // around. Fine for a POC summary; page it if the table ever grows.
      const items = await sbRows("image_batch_items?select=status,image_batches(model)&limit=1000");
      for (const it of items) {
        const model = (it.image_batches && it.image_batches.model) || "unknown";
        const row = perModel.get(model) || { generated: 0, approved: 0 };
        if (["generated", "approved", "rejected"].includes(it.status)) row.generated++;
        if (it.status === "approved") row.approved++;
        perModel.set(model, row);
      }
    } catch (e) {
      if (isMissingTable(e)) itemsMissing = true;
      else throw e;
    }
  }
  const statsRows = models.map((m) => {
    const row = perModel.get(m.model) || { generated: 0, approved: 0 };
    return {
      model: m.model, display_name: m.display_name, batch_price_usd: m.batch_price_usd,
      generated: row.generated, approved: row.approved,
      cost_usd: round2(row.generated * (Number(m.batch_price_usd) || 0)),
    };
  });
  for (const [model, row] of perModel) {
    if (!models.some((m) => m.model === model)) {
      statsRows.push({ model, display_name: model, batch_price_usd: null, generated: row.generated, approved: row.approved, cost_usd: null });
    }
  }
  return {
    ok: true, tablesMissing: itemsMissing, price_source: source, models,
    stats: statsRows,
    total: {
      generated: statsRows.reduce((s, x) => s + x.generated, 0),
      approved: statsRows.reduce((s, x) => s + x.approved, 0),
      cost_usd: round2(statsRows.reduce((s, x) => s + (x.cost_usd || 0), 0)),
    },
  };
}

module.exports = async (req, res) => {
  const email = requireAdmin(req, res);
  if (!email) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed — POST { action } only" });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ ok: false, error: "invalid JSON body" }); return; }
  const action = String((body && body.action) || "").trim();
  try {
    let out;
    switch (action) {
      case "list-articles": out = await listArticles(body); break;
      case "create": out = await createBatch(body, email); break;
      case "check": out = await checkBatch(body); break;
      case "approve": out = await approveItems(body); break;
      case "reject": out = await rejectItems(body); break;
      case "list-batches": out = await listBatches(body); break;
      case "list-items": out = await listItems(body); break;
      case "stats": out = await stats(); break;
      default:
        res.status(400).json({ ok: false, error: `unknown action: ${action || "(none)"} — use list-articles, create, check, approve, reject, list-batches, list-items or stats` });
        return;
    }
    res.status(200).json(out);
  } catch (e) {
    if (isMissingTable(e)) {
      res.status(503).json({ ok: false, error: TABLES_MISSING });
      return;
    }
    const status = (e && e.status) || 500;
    res.status(status).json({ ok: false, error: String((e && e.message) || e).slice(0, 500) });
  }
};
