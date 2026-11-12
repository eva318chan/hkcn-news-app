// POST /api/admin/r2-migrate — one-time migration utility (Google SSO admin
// session only; never public, never keyed by INGEST_SECRET).
//   Fetches the 5 AI design images from their public GitHub raw URLs and
//   PUTs each into the Cloudflare R2 bucket, using the S3-compatible API
//   with credentials from process.env (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_ENDPOINT, R2_BUCKET). Signing is SigV4 with Node's built-in crypto —
//   no SDK dependency. PUTs are idempotent, so re-running is safe.
//   The R2 credentials are stored encrypted in Vercel (readable by serverless
//   functions at runtime, NOT readable back through the Vercel API), which is
//   why the upload happens from inside this function instead of an external
//   script. Returns a JSON summary of keys uploaded with their sizes.
//   Do not call this from the pipeline — it is a one-time migration only.
"use strict";
const crypto = require("crypto");
const { requireAdmin } = require("../../lib/admin-auth");

const FILES = [
  { url: "https://raw.githubusercontent.com/eva318chan/hkcn-news-app/main/design/202611/20261105-eu-ukraine-reconstruction-talks.jpg", key: "design/202611/20261105-eu-ukraine-reconstruction-talks.jpg", expected: 247683 },
  { url: "https://raw.githubusercontent.com/eva318chan/hkcn-news-app/main/design/202611/20261105-kospi-morning-drop.jpg", key: "design/202611/20261105-kospi-morning-drop.jpg", expected: 134563 },
  { url: "https://raw.githubusercontent.com/eva318chan/hkcn-news-app/main/design/202611/20261105-trump-midterms-remarks.jpg", key: "design/202611/20261105-trump-midterms-remarks.jpg", expected: 133569 },
  { url: "https://raw.githubusercontent.com/eva318chan/hkcn-news-app/main/design/202611/20261113-hengfa-school-assault-design.jpg", key: "design/202611/20261113-hengfa-school-assault-design.jpg", expected: 660940 },
  { url: "https://raw.githubusercontent.com/eva318chan/hkcn-news-app/main/design/202611/20261113-nvidia-huang-resigns-design.jpg", key: "design/202611/20261113-nvidia-huang-resigns-design.jpg", expected: 679968 },
];

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data).digest(); }
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// SigV4-signed PUT to an S3-compatible endpoint (R2 uses region "auto").
async function s3Put({ endpoint, bucket, key, body, accessKey, secretKey }) {
  const url = new URL(`${endpoint.replace(/\/$/, "")}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const amzdate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const canonicalHeaders = `content-type:image/jpeg\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");
  const scope = `${datestamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzdate, scope, sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, datestamp), "auto"), "s3"), "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  const r = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": "image/jpeg",
      "x-amz-date": amzdate,
      "x-amz-content-sha256": payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`R2 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  const accessKey = process.env.R2_ACCESS_KEY_ID || "";
  const secretKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const endpoint = (process.env.R2_ENDPOINT || "").replace(/\/$/, "");
  const bucket = process.env.R2_BUCKET || "";
  if (!accessKey || !secretKey || !endpoint || !bucket) {
    res.status(503).json({ ok: false, error: "R2 credentials not configured" });
    return;
  }
  const publicBase = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, "");

  const results = await Promise.all(FILES.map(async (f) => {
    try {
      const g = await fetch(f.url);
      if (!g.ok) return { key: f.key, ok: false, error: `GitHub fetch ${g.status}` };
      const buf = Buffer.from(await g.arrayBuffer());
      if (buf.length !== f.expected) {
        return { key: f.key, ok: false, error: `size mismatch: fetched ${buf.length}, expected ${f.expected}` };
      }
      await s3Put({ endpoint, bucket, key: f.key, body: buf, accessKey, secretKey });
      return {
        key: f.key, ok: true, bytes: buf.length,
        url: publicBase ? `${publicBase}/${f.key}` : null,
      };
    } catch (e) {
      return { key: f.key, ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }));

  const uploaded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  res.status(200).json({ ok: failed.length === 0, uploaded, failed });
};
