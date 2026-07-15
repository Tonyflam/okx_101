import type { ChartSpec, Scene, StorySpec } from "./types.js";
import { renderChart } from "./renderer-charts.js";
import { escapeAttr, escapeHtml, fmtNum } from "./util.js";

/** Render a StorySpec to a fully self-contained scrollytelling HTML page. */
export function buildStoryHtml(spec: StorySpec, baseUrl: string): string {
  const title = escapeHtml(spec.title);
  const subtitle = escapeHtml(spec.subtitle);
  const scenes = spec.scenes.map((s, i) => renderScene(s, i)).join("\n");
  const ledger = renderLedger(spec);
  const auditLine = auditFooter(spec);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — Plotline</title>
<meta name="description" content="${escapeAttr(spec.subtitle)}"/>
<meta property="og:title" content="${escapeAttr(spec.title)}"/>
<meta property="og:description" content="${escapeAttr(spec.subtitle)} · A Plotline data story"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${escapeAttr(baseUrl)}/story/${escapeAttr(spec.id)}"/>
<meta name="twitter:card" content="summary"/>
<style>${css()}</style>
</head>
<body class="theme-${escapeAttr(spec.theme)}">
<div class="progress"><div class="progress-fill" id="pf"></div></div>
<nav class="topnav">
  <a class="brand" href="/">Plotline</a>
  <span class="crumb">data story · ${escapeHtml(spec.dataset.name)}</span>
</nav>
<main>
${scenes}
${ledger}
</main>
<footer class="site-footer">
  <div class="foot-inner">
    <p class="foot-brand">Made with <a href="/">Plotline</a> — the storytelling engine of the agent economy. An ASP on OKX.AI.</p>
    ${auditLine}
    <p class="foot-links"><a href="/story/${escapeAttr(spec.id)}.json">story spec (JSON)</a> · generated ${escapeHtml(new Date(spec.createdAt).toUTCString())}</p>
  </div>
</footer>
<script>${runtimeJs()}</script>
</body>
</html>`;
}

// ── Scenes ─────────────────────────────────────────────────────────────────

function renderScene(scene: Scene, index: number): string {
  if (scene.kind === "hero") {
    const stat = scene.stat ? renderBignum(scene.stat) : "";
    return `<section class="scene hero">
  <div class="hero-inner">
    <p class="kicker reveal" style="--d:0ms">${escapeHtml(scene.kicker)}</p>
    <h1 class="reveal" style="--d:120ms">${escapeHtml(scene.headline)}</h1>
    <p class="sub reveal" style="--d:260ms">${escapeHtml(scene.sub)}</p>
    ${stat}
    <div class="scroll-hint reveal" style="--d:600ms"><span></span>scroll</div>
  </div>
</section>`;
  }
  if (scene.kind === "closing") {
    return `<section class="scene closing">
  <div class="closing-inner">
    <h2 class="reveal">${escapeHtml(scene.headline)}</h2>
    <p class="reveal" style="--d:150ms">${escapeHtml(scene.body)}</p>
  </div>
</section>`;
  }
  const flip = index % 2 === 0 ? "" : " flip";
  const chart = scene.chart ? renderChartBlock(scene.chart) : "";
  const factRefs = scene.factIds.map((f) => `<a href="#${escapeAttr(f)}" class="factref">${escapeHtml(f)}</a>`).join(" ");
  return `<section class="scene insight${flip}">
  <div class="insight-grid${chart ? "" : " solo"}">
    <div class="prose">
      <p class="scene-no reveal" style="--d:0ms">${String(index).padStart(2, "0")}</p>
      <h2 class="reveal" style="--d:100ms">${escapeHtml(scene.headline)}</h2>
      <p class="body reveal" style="--d:220ms">${escapeHtml(scene.body)}</p>
      <p class="verified reveal" style="--d:320ms"><span class="check">✓</span> verified fact ${factRefs}</p>
    </div>
    ${chart}
  </div>
</section>`;
}

function renderChartBlock(chart: ChartSpec): string {
  if (chart.type === "bignum") {
    return `<div class="chart-wrap">${renderBignum(chart)}</div>`;
  }
  return `<div class="chart-wrap reveal" style="--d:200ms">${renderChart(chart)}</div>`;
}

function renderBignum(b: Extract<ChartSpec, { type: "bignum" }>): string {
  const countable = b.numeric !== undefined && Number.isFinite(b.numeric);
  const valueAttr = countable ? ` data-count="${escapeAttr(String(b.numeric))}" data-suffix="${escapeAttr(b.suffix ?? "")}" data-prefix="${escapeAttr(b.prefix ?? "")}"` : "";
  return `<div class="bignum reveal" style="--d:420ms">
  <div class="bignum-value"${valueAttr}>${escapeHtml(b.value)}</div>
  <div class="bignum-label">${escapeHtml(b.label)}</div>
</div>`;
}

// ── Fact ledger appendix ───────────────────────────────────────────────────

function renderLedger(spec: StorySpec): string {
  const rows = spec.facts
    .map(
      (f) => `<tr id="${escapeAttr(f.id)}">
  <td class="lid">${escapeHtml(f.id)}</td>
  <td class="lstat">${escapeHtml(f.statement)}</td>
  <td class="lev">${escapeHtml(f.evidence)}</td>
</tr>`,
    )
    .join("\n");
  const cols = spec.dataset.columns.map((c) => `${escapeHtml(c.name)} <em>(${c.type})</em>`).join(" · ");
  const notes = spec.dataset.notes.length
    ? `<p class="ledger-notes">Notes: ${spec.dataset.notes.map(escapeHtml).join(" ")}</p>`
    : "";
  return `<section class="ledger">
  <div class="ledger-inner">
    <h3>The fact ledger</h3>
    <p class="ledger-sub">Every claim in this story traces to a fact computed directly from the data — statistics from code, narrative from facts, never the reverse.</p>
    <p class="ledger-meta">${escapeHtml(spec.dataset.name)} · ${spec.dataset.rowCount} rows · columns: ${cols}</p>
    ${notes}
    <table>
      <thead><tr><th>ID</th><th>Fact</th><th>Method</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function auditFooter(spec: StorySpec): string {
  if (spec.narrativeMode === "ai" && spec.numericAudit) {
    const a = spec.numericAudit;
    return `<p class="foot-audit">AI narration · numeric audit: ${a.verified}/${a.checked} numbers verified against the fact ledger${a.rewritten > 0 ? `, ${a.rewritten} scene(s) rewritten deterministically after failing audit` : ""}.</p>`;
  }
  return `<p class="foot-audit">Deterministic narration — every sentence generated from computed facts.</p>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────

function css(): string {
  return `
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:var(--font);background:var(--bg);color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased}

.theme-midnight{--bg:#07080f;--bg2:#0d0f1c;--card:#11142299;--ink:#eef0fa;--muted:#8b90ad;--accent:#6ea8ff;--accent2:#ffd166;--line:#232842;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--display:var(--font)}
.theme-paper{--bg:#faf6ef;--bg2:#f3ecdf;--card:#ffffffcc;--ink:#1c1a16;--muted:#6e675c;--accent:#b3541e;--accent2:#1f6f5c;--line:#e2d9c8;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--display:Georgia,"Times New Roman",serif}
.theme-neon{--bg:#050505;--bg2:#0a0a12;--card:#101018cc;--ink:#e8ffe8;--muted:#7a8a7a;--accent:#39ff88;--accent2:#ff3980;--line:#1c2a1c;--font:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--display:var(--font)}

.progress{position:fixed;top:0;left:0;right:0;height:3px;background:transparent;z-index:60}
.progress-fill{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .1s linear}
.topnav{position:fixed;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:14px 26px;z-index:50;backdrop-filter:blur(8px)}
.brand{color:var(--ink);text-decoration:none;font-weight:800;letter-spacing:.06em}
.crumb{color:var(--muted);font-size:.8rem}

.scene{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:96px 24px;position:relative}
.hero{background:radial-gradient(ellipse 80% 60% at 50% 35%,var(--bg2),var(--bg))}
.hero-inner{max-width:900px;text-align:center}
.kicker{color:var(--accent);text-transform:uppercase;letter-spacing:.28em;font-size:.78rem;font-weight:700}
h1{font-family:var(--display);font-size:clamp(2.4rem,7vw,4.6rem);line-height:1.08;margin:22px 0 18px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:clamp(1rem,2.2vw,1.25rem);max-width:640px;margin:0 auto}
.bignum{margin:44px auto 0}
.bignum-value{font-size:clamp(3.4rem,10vw,7rem);font-weight:800;letter-spacing:-.03em;background:linear-gradient(120deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.bignum-label{color:var(--muted);margin-top:6px;font-size:.95rem}
.scroll-hint{margin-top:70px;color:var(--muted);font-size:.75rem;letter-spacing:.22em;text-transform:uppercase}
.scroll-hint span{display:block;width:1px;height:44px;margin:0 auto 10px;background:linear-gradient(var(--accent),transparent);animation:drip 1.8s ease-in-out infinite}
@keyframes drip{0%{transform:scaleY(.2);transform-origin:top}55%{transform:scaleY(1)}100%{opacity:0}}

.insight-grid{display:grid;grid-template-columns:minmax(300px,440px) minmax(320px,640px);gap:64px;align-items:center;max-width:1180px;width:100%}
.insight.flip .insight-grid{direction:rtl}
.insight.flip .insight-grid>*{direction:ltr}
.insight-grid.solo{grid-template-columns:minmax(300px,640px);justify-content:center;text-align:left}
.scene-no{color:var(--accent);font-weight:800;font-size:.85rem;letter-spacing:.3em}
h2{font-family:var(--display);font-size:clamp(1.5rem,3.4vw,2.3rem);line-height:1.2;margin:12px 0 16px}
.body{color:var(--muted);font-size:1.05rem}
.verified{margin-top:18px;font-size:.78rem;color:var(--muted);letter-spacing:.04em}
.check{color:var(--accent);font-weight:700;margin-right:6px}
.factref{color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent)}

.chart-wrap{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 12px 8px;box-shadow:0 18px 50px #00000038}
.chart{width:100%;height:auto;display:block}

.chart text{font-family:var(--font)}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .grid.zero{stroke:var(--muted);stroke-width:1}
.chart .tick{fill:var(--muted);font-size:13px}
.chart .axis-label{fill:var(--muted);font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
.chart .badge{fill:var(--accent2);font-size:14px;font-weight:700}
.chart .stroke{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:var(--len);stroke-dashoffset:var(--len)}
.on .chart .stroke{transition:stroke-dashoffset 1.7s cubic-bezier(.4,0,.2,1) .15s;stroke-dashoffset:0}
.chart .area{fill:var(--accent);opacity:0}
.on .chart .area{transition:opacity 1.2s ease .9s;opacity:.10}
.chart .trend{stroke:var(--accent2);stroke-width:2;stroke-dasharray:7 7;opacity:0}
.on .chart .trend{transition:opacity .8s ease 1.2s;opacity:.9}
.chart .mark{fill:var(--accent2);opacity:0}
.on .chart .mark{transition:opacity .5s ease 1.4s;opacity:1}
.chart .mark-pulse{fill:none;stroke:var(--accent2);stroke-width:2;opacity:0}
.on .chart .mark-pulse{animation:pulse 2s ease-out 1.5s infinite}
@keyframes pulse{0%{opacity:.9;transform:none}100%{opacity:0;transform:scale(1.9);transform-origin:center;transform-box:fill-box}}
.chart .mark-label{fill:var(--accent2);font-size:13px;font-weight:700;opacity:0}
.on .chart .mark-label{transition:opacity .5s ease 1.5s;opacity:1}
.chart .bar{fill:var(--accent);opacity:.75;transform:scaleY(0);transform-origin:bottom;transform-box:fill-box}
.chart .bar.hot{fill:var(--accent2);opacity:1}
.on .chart .bar{transition:transform .8s cubic-bezier(.2,.7,.3,1) calc(var(--i)*70ms);transform:scaleY(1)}
.chart .val{fill:var(--muted);font-size:13px;font-weight:600;opacity:0}
.on .chart .val{transition:opacity .5s ease calc(.6s + var(--i)*70ms);opacity:1}
.chart .dot{fill:var(--accent);opacity:0}
.on .chart .dot{transition:opacity .5s ease calc(var(--i)*14ms);opacity:.78}
.chart .slice{opacity:0}
.on .chart .slice{transition:opacity .6s ease calc(var(--i)*130ms);opacity:1}
.chart .slice.s0{fill:var(--accent)}.chart .slice.s1{fill:var(--accent2)}
.chart .slice.s2{fill:#9b7bff}.chart .slice.s3{fill:#4fd1c5}
.chart .slice.s4{fill:#f56fa1}.chart .slice.s5{fill:#8a93a6}
.chart .legend{fill:var(--ink);font-size:15px;font-weight:600}
.chart .legend-val{fill:var(--muted);font-size:13px}
.chart .donut-center{fill:var(--ink);font-size:34px;font-weight:800}
.chart .donut-sub{fill:var(--muted);font-size:13px;letter-spacing:.2em;text-transform:uppercase}

.closing{background:radial-gradient(ellipse 70% 50% at 50% 60%,var(--bg2),var(--bg))}
.closing-inner{max-width:680px;text-align:center}
.closing p{color:var(--muted);margin-top:16px}

.ledger{padding:90px 24px;background:var(--bg2)}
.ledger-inner{max-width:1080px;margin:0 auto}
.ledger h3{font-family:var(--display);font-size:1.7rem;margin-bottom:8px}
.ledger-sub{color:var(--muted);max-width:640px}
.ledger-meta{color:var(--muted);font-size:.82rem;margin-top:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.ledger-notes{color:var(--accent2);font-size:.82rem;margin-top:8px}
.ledger table{width:100%;border-collapse:collapse;margin-top:10px;font-size:.9rem}
.ledger th{text-align:left;color:var(--muted);text-transform:uppercase;font-size:.72rem;letter-spacing:.14em;padding:12px 10px;border-bottom:1px solid var(--line)}
.ledger td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.ledger .lid{color:var(--accent);font-weight:700;white-space:nowrap}
.ledger .lev{color:var(--muted);font-size:.8rem;max-width:260px}
tr:target td{background:var(--card)}

.site-footer{padding:44px 24px;border-top:1px solid var(--line)}
.foot-inner{max-width:1080px;margin:0 auto;color:var(--muted);font-size:.85rem}
.foot-inner a{color:var(--accent);text-decoration:none}
.foot-audit{margin-top:8px}
.foot-links{margin-top:8px;font-size:.78rem}

.reveal{opacity:0;transform:translateY(26px);transition:opacity .8s ease var(--d,0ms),transform .8s cubic-bezier(.2,.7,.3,1) var(--d,0ms)}
.on .reveal,.reveal.on{opacity:1;transform:none}

@media (max-width:900px){
  .insight-grid{grid-template-columns:1fr;gap:32px}
  .insight.flip .insight-grid{direction:ltr}
  .scene{padding:72px 18px;min-height:auto}
}
@media (prefers-reduced-motion:reduce){
  .reveal{opacity:1;transform:none;transition:none}
  .on .chart .stroke,.chart .stroke{stroke-dashoffset:0;transition:none}
  .chart .bar{transform:scaleY(1);transition:none}
  .chart .dot,.chart .slice,.chart .val,.chart .trend,.chart .mark,.chart .mark-label{opacity:1;transition:none}
}
`.trim();
}

// ── Runtime JS (no backticks — inlined into a template literal) ────────────

function runtimeJs(): string {
  return `
(function(){
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        e.target.classList.add('on');
        var counts = e.target.querySelectorAll('[data-count]');
        counts.forEach(startCount);
        io.unobserve(e.target);
      }
    });
  },{threshold:0.22});
  document.querySelectorAll('.scene,.ledger').forEach(function(s){io.observe(s);});

  var pf = document.getElementById('pf');
  function onScroll(){
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    pf.style.width = (max>0 ? (h.scrollTop/max*100) : 0) + '%';
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();

  function fmt(n){
    var abs = Math.abs(n);
    if(abs>=1e9) return (n/1e9).toFixed(2).replace(/\\.?0+$/,'')+'B';
    if(abs>=1e6) return (n/1e6).toFixed(2).replace(/\\.?0+$/,'')+'M';
    if(abs>=1e4) return (n/1e3).toFixed(1).replace(/\\.?0+$/,'')+'K';
    if(abs>=100) return n.toFixed(1).replace(/\\.?0+$/,'');
    if(abs>=1) return n.toFixed(2).replace(/\\.?0+$/,'');
    if(abs===0) return '0';
    return n.toPrecision(3);
  }
  function startCount(el){
    if(el.dataset.done) return;
    el.dataset.done = '1';
    var target = parseFloat(el.dataset.count);
    if(!isFinite(target)) return;
    var suffix = el.dataset.suffix || '';
    var prefix = el.dataset.prefix || '';
    var t0 = null, dur = 1500;
    function step(ts){
      if(t0===null) t0 = ts;
      var p = Math.min(1,(ts-t0)/dur);
      var eased = 1 - Math.pow(1-p,3);
      var v = target * eased;
      el.textContent = prefix + fmt(v) + suffix;
      if(p<1) requestAnimationFrame(step);
      else el.textContent = prefix + fmt(target) + suffix;
    }
    requestAnimationFrame(step);
  }
})();
`.trim();
}
