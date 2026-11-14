// GET /api/article-page?slug=<id> — full article HTML, server-rendered so that
// og:title / og:description / og:image / og:url are in the first HTML (social
// sharing and Google need this; client-side JS cannot do it).
// Rewrites in vercel.json map /a/<id>.html here, so article URLs do not change.
// Template replicates the live static a/*.html pages: same classes, same
// header, same language-switch script (adapted to fetch /api/article).
"use strict";
const { getArticle, siteUrl, setCache } = require("../lib/data");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const CATS_ZH = {hk:"港聞",china:"中國",world:"國際",finance:"財經",tech:"科技",entertainment:"娛樂",others:"其他"};

const STANDARD_FOOTER = "摘要由本站重新編寫，圖片版權歸原新聞機構所有。";

// UI strings that follow the language switcher (title/summary/tags already do
// via /api/article). Source names arrive from the DB as one string, so known
// sources are mapped here; anything unlisted falls back to the stored name.
const READ_ORIG = { en: "Read original \u2192", zh_hant: "閱讀原文 \u2192", zh_hans: "阅读原文 \u2192" };
const FOOTER_TEXT = {
  en: "Summary rewritten by this site. Image copyright belongs to the original news organisation.",
  zh_hant: STANDARD_FOOTER,
  zh_hans: "摘要由本站重新编写，图片版权归原新闻机构所有。",
};
const SOURCE_NAMES = {
  "香港電台": { en: "RTHK", zh_hans: "香港电台" },
  "政府新聞處": { en: "Information Services Department", zh_hans: "政府新闻处" },
  "京報網": { zh_hans: "京报网" },
  "立康醫療": { zh_hans: "立康医疗" },
  "都市日報": { zh_hans: "都市日报" },
  "UHK 港生活": { zh_hans: "UHK 港生活" },
  "新假期": { zh_hans: "新假期" },
  "Dim Sum Daily": { zh_hans: "Dim Sum Daily" },
};

// published_at is an instant (Supabase renders timestamptz as UTC, seed rows
// carry +08:00); display it as Hong Kong wall time, not the raw UTC string
// (an early-morning HKT article otherwise shows the previous day).
function fmtDateTime(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return (iso || "").slice(0, 16).replace("T", " ");
  // Hong Kong is UTC+8 all year (no DST): shift the instant, then read UTC parts.
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// Inline script from the live article pages, with one change: it fetches
// /api/article?slug= instead of ../data/<date>.json (there are no data files here).
const LANG_SCRIPT = `
(function(){
  var SITE='中港新聞速報';
  var READ_ORIG=${JSON.stringify(READ_ORIG)};
  var FOOTER_TEXT=${JSON.stringify(FOOTER_TEXT)};
  var SOURCE_NAMES=${JSON.stringify(SOURCE_NAMES)};
  function esc(s){return String(s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}
  function setLogo(){var dark=document.documentElement.getAttribute('data-theme')==='dark';var bn=document.getElementById('brandName');if(bn&&bn.style.display==='flex')return;var l=document.getElementById('logoLight'),d=document.getElementById('logoDark');if(l&&d){l.style.display=dark?'none':'';d.style.display=dark?'':'none';}}
  var LANG='zh_hant';
  try{ LANG=localStorage.getItem('hks_lang')||'zh_hant'; }catch(e){}
  var aid=location.pathname.split('/').pop().replace(/\\.html$/,'');
  function pick(o){ return (o&&(o[LANG]||o.zh_hant))||''; }
  function setActive(){
    var btns=document.querySelectorAll('.lang-switch button');
    for(var i=0;i<btns.length;i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-lang')===LANG);
  }
  function apply(a){
    setActive();
    document.documentElement.lang = LANG==='en'?'en':(LANG==='zh_hans'?'zh-CN':'zh-Hant');
    var ro=document.getElementById('readOrig');
    if(ro) ro.textContent=READ_ORIG[LANG]||READ_ORIG.zh_hant;
    var pf=document.getElementById('pageFooter');
    if(pf&&pf.getAttribute('data-standard')==='1') pf.textContent=FOOTER_TEXT[LANG]||FOOTER_TEXT.zh_hant;
    if(!a) return;
    var h1=document.querySelector('h1.article-title');
    var lead=document.querySelector('p.article-summary');
    var tags=document.querySelector('.article-tags');
    var t=pick(a.title), s=pick(a.summary);
    if(h1&&t) h1.textContent=t;
    if(lead&&s) lead.textContent=s;
    if(tags&&a.tags){
      var arr=a.tags[LANG]||a.tags.zh_hant||[];
      if(typeof arr==='string') arr=[arr];
      var h='';
      for(var i=0;i<arr.length;i++) h+='<button class="tag">#'+esc(arr[i])+'</button>';
      tags.innerHTML=h;
    }
    var sn=document.getElementById('srcName');
    if(sn){
      var n=(a.source&&(a.source.name||a.source))||'';
      var m=SOURCE_NAMES[n];
      sn.textContent=(m&&m[LANG])||n;
    }
    if(t) document.title=t+' | '+SITE;
  }
  var btns=document.querySelectorAll('.lang-switch button');
  for(var i=0;i<btns.length;i++)(function(b){
    b.addEventListener('click',function(){
      LANG=b.getAttribute('data-lang');
      try{ localStorage.setItem('hks_lang',LANG); }catch(e){}
      apply(window.__ADATA||null);
    });
  })(btns[i]);
  var tb=document.getElementById('themeBtn');
  function setIcon(){ if(tb) tb.textContent=document.documentElement.getAttribute('data-theme')==='dark'?'\\u2600\\uFE0F':'\\uD83C\\uDF19'; }
  if(tb) tb.addEventListener('click',function(){
    var cur=document.documentElement.getAttribute('data-theme')==='dark';
    var t=cur?'light':'dark';
    document.documentElement.setAttribute('data-theme',t);
    try{ localStorage.setItem('hks_theme',t); }catch(e){}
    setIcon(); setLogo();
  });
  setIcon(); setActive(); setLogo();
  fetch('/api/article?slug='+encodeURIComponent(aid)).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(j){
    window.__ADATA=j.article||null; apply(window.__ADATA);
  }).catch(function(){});
})();
`;

function pageHTML(a, base) {
  const zhTitle = a.title.zh_hant || a.title.en || "";
  const zhSummary = a.summary.zh_hant || a.summary.en || "";
  const tags = (a.tags.zh_hant || []).map((g) => `<button class="tag">#${esc(g)}</button>`).join("");
  const url = `${base}/a/${a.id}.html`;
  const img = a.image_url
    ? `<div class="article-hero"><img src="${esc(a.image_url)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;noimg&quot;>🏅</div>'"></div>`
    : `<div class="article-hero"><div class="noimg">🏅</div></div>`;
  const caption = a.image_caption
    ? `<p style="font-size:13px;color:#888;margin:8px 0 0">${esc(a.image_caption)}</p>`
    : "";
  // Extra real photos, [{url, caption}] — rendered below the summary, each
  // with the same hero treatment as the main image. Absent for most articles.
  const extras = Array.isArray(a.extra_images) ? a.extra_images : [];
  const extrasHtml = extras.map((e) => {
    const u = e && typeof e.url === "string" ? esc(e.url) : "";
    if (!u) return "";
    const cap = e.caption
      ? `<p style="font-size:13px;color:#888;margin:8px 0 0">${esc(e.caption)}</p>` : "";
    return `<div class="article-hero" style="margin-top:16px"><img src="${u}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;noimg&quot;>🏅</div>'"></div>${cap}`;
  }).join("\n");
  const ogImage = a.image_url ? `<meta property="og:image" content="${esc(a.image_url)}">\n` : "";
  const footer = esc(a.footer_note || STANDARD_FOOTER);
  const footerIsStandard = !a.footer_note;
  const srcName = esc(a.source?.name || "");
  const srcUrl = esc(a.source?.url || "");
  return `<!DOCTYPE html>
<html lang="zh-Hant" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(zhTitle)} | 中港新聞速報</title>
<meta name="description" content="${esc(zhSummary)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="中港新聞速報 HK-China News Express">
<meta property="og:title" content="${esc(zhTitle)}">
<meta property="og:description" content="${esc(zhSummary)}">
${ogImage}<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../assets/logo-light.png">
<link rel="stylesheet" href="../assets/style.css">
<script>try{var _t=localStorage.getItem("hks_theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=_t;}catch(e){}
function logoFallback(){var b=document.getElementById("brandName");if(b)b.style.display="flex";["logoLight","logoDark"].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display="none";});}</script>
<!-- Vercel Web Analytics: window.va stub + script. This is exactly what
     @vercel/analytics v2 inject() does in production (it loads
     /_vercel/insights/script.js); no npm package is needed for a
     no-build static site. -->
<script>
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="../" aria-label="home">
    <img id="logoLight" class="logo-img" src="../assets/logo-light.png" alt="中港新聞速報 HK-China News Express" onerror="logoFallback()">
    <img id="logoDark" class="logo-img" src="../assets/logo-dark.png" alt="中港新聞速報 HK-China News Express" style="display:none" onerror="logoFallback()">
    <span class="brand-name" id="brandName" style="display:none"><strong>中港新聞速報</strong><small>HK-CHINA NEWS EXPRESS</small></span>
  </a>
  <div class="controls">
    <div class="lang-switch" role="group" aria-label="language"><button data-lang="en">EN</button><button data-lang="zh_hant">繁</button><button data-lang="zh_hans">简</button></div>
    <button id="themeBtn" class="icon-btn" aria-label="theme">🌙</button>
  </div>
</header>
<main class="article-wrap">
${img}
${caption}  <div class="card-top"><span class="cat-tag">${esc(a.category)}</span><span>${esc(fmtDateTime(a.published_at))}</span><span> · <span id="srcName">${srcName}</span></span></div>
  <h1 class="article-title">${esc(zhTitle)}</h1>
  <p class="lead article-summary">${esc(zhSummary)}</p>
${extrasHtml}  <div class="tags article-tags">${tags}</div>
  <div style="margin:20px 0;display:flex;gap:10px;flex-wrap:wrap">
    <a class="abtn primary" style="font-size:15px;padding:10px 22px" href="${srcUrl}" target="_blank" rel="noopener" id="readOrig">閱讀原文 →</a>
    <a class="abtn" style="font-size:15px;padding:10px 18px" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" target="_blank" rel="noopener">分享到 Facebook</a>
  </div>
</main>
<footer><p id="pageFooter"${footerIsStandard ? ' data-standard="1"' : ''}>${footer}</p></footer>
<script>${LANG_SCRIPT}</script>
</body>
</html>
`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "method not allowed" });
    return;
  }
  const slug = String((req.query || {}).slug || "").trim();
  if (!slug) { res.status(400).send("missing slug"); return; }
  try {
    const a = await getArticle(slug);
    if (!a) { res.status(404).send("not found"); return; }
    setCache(res, 60);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(pageHTML(a, siteUrl(req)));
  } catch (e) {
    res.status(500).send(String(e.message || e).slice(0, 200));
  }
};
