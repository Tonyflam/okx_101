import type { ChartSpec } from "./types.js";
import { escapeHtml, fmtNum, niceTicks } from "./util.js";

const W = 800;
const H = 440;
const PAD = { top: 28, right: 32, bottom: 64, left: 76 };

/** Render a ChartSpec to a self-contained, animatable inline SVG. */
export function renderChart(spec: ChartSpec): string {
  switch (spec.type) {
    case "line":
      return lineSvg(spec);
    case "bar":
      return barSvg(spec);
    case "scatter":
      return scatterSvg(spec);
    case "donut":
      return donutSvg(spec);
    case "bignum":
      return ""; // rendered in HTML by the page renderer
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function svgOpen(cls: string): string {
  return `<svg class="chart ${cls}" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">`;
}

function plotArea(): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } {
  const x0 = PAD.left;
  const y0 = PAD.top;
  const x1 = W - PAD.right;
  const y1 = H - PAD.bottom;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function yScale(min: number, max: number): (v: number) => number {
  const { y0, y1 } = plotArea();
  const span = max - min || 1;
  return (v) => y1 - ((v - min) / span) * (y1 - y0);
}

function gridAndAxis(ticks: number[], sy: (v: number) => number): string {
  const { x0, x1 } = plotArea();
  let out = "";
  for (const t of ticks) {
    const y = sy(t);
    out += `<line class="grid" x1="${x0}" y1="${r1(y)}" x2="${x1}" y2="${r1(y)}"/>`;
    out += `<text class="tick" x="${x0 - 10}" y="${r1(y + 4)}" text-anchor="end">${escapeHtml(fmtNum(t))}</text>`;
  }
  return out;
}

function xLabels(labels: string[], positions: number[], maxShown = 6): string {
  const { y1 } = plotArea();
  const n = labels.length;
  if (n === 0) return "";
  const step = Math.max(1, Math.ceil(n / maxShown));
  let out = "";
  for (let i = 0; i < n; i += step) {
    out += `<text class="tick" x="${r1(positions[i] as number)}" y="${y1 + 24}" text-anchor="middle">${escapeHtml(short(labels[i] as string))}</text>`;
  }
  // Always show the last label when it wasn't hit by the stride.
  if ((n - 1) % step !== 0) {
    out += `<text class="tick" x="${r1(positions[n - 1] as number)}" y="${y1 + 24}" text-anchor="middle">${escapeHtml(short(labels[n - 1] as string))}</text>`;
  }
  return out;
}

function short(s: string, max = 12): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function polylineLength(pts: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

// ── Line ───────────────────────────────────────────────────────────────────

function lineSvg(spec: Extract<ChartSpec, { type: "line" }>): string {
  const { x0, y1: yBottom, w } = plotArea();
  const pts = spec.points;
  if (pts.length === 0) return "";
  const ys = pts.map((p) => p.y);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (spec.trend) {
    lo = Math.min(lo, spec.trend.intercept, spec.trend.slope * (pts.length - 1) + spec.trend.intercept);
    hi = Math.max(hi, spec.trend.intercept, spec.trend.slope * (pts.length - 1) + spec.trend.intercept);
  }
  const ticks = niceTicks(lo, hi, 5);
  const tickLo = ticks[0] as number;
  const tickHi = ticks[ticks.length - 1] as number;
  const sy = yScale(tickLo, tickHi);
  const sx = (i: number) => x0 + (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);

  const coords = pts.map((p, i) => ({ x: sx(i), y: sy(p.y) }));
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${r1(c.x)},${r1(c.y)}`).join(" ");
  const areaPath = `${path} L${r1(coords[coords.length - 1]!.x)},${yBottom} L${r1(coords[0]!.x)},${yBottom} Z`;
  const len = Math.ceil(polylineLength(coords));

  let overlay = "";
  if (spec.trend) {
    const tA = { x: sx(0), y: sy(spec.trend.intercept) };
    const tB = { x: sx(pts.length - 1), y: sy(spec.trend.slope * (pts.length - 1) + spec.trend.intercept) };
    overlay += `<line class="trend" x1="${r1(tA.x)}" y1="${r1(tA.y)}" x2="${r1(tB.x)}" y2="${r1(tB.y)}"/>`;
  }
  if (spec.markIndex !== undefined && coords[spec.markIndex]) {
    const m = coords[spec.markIndex]!;
    overlay += `<circle class="mark-pulse" cx="${r1(m.x)}" cy="${r1(m.y)}" r="10"/>`;
    overlay += `<circle class="mark" cx="${r1(m.x)}" cy="${r1(m.y)}" r="5"/>`;
    overlay += `<text class="mark-label" x="${r1(Math.min(m.x, W - PAD.right - 60))}" y="${r1(Math.max(m.y - 16, 16))}" text-anchor="middle">${escapeHtml(short(pts[spec.markIndex]!.x, 16))}</text>`;
  }

  return (
    svgOpen("line") +
    gridAndAxis(ticks, sy) +
    `<path class="area" d="${areaPath}"/>` +
    `<path class="stroke" d="${path}" style="--len:${len}" pathLength="${len}"/>` +
    overlay +
    xLabels(pts.map((p) => p.x), coords.map((c) => c.x)) +
    `<text class="axis-label" x="${x0}" y="16">${escapeHtml(short(spec.yLabel, 40))}</text>` +
    `</svg>`
  );
}

// ── Bar ────────────────────────────────────────────────────────────────────

function barSvg(spec: Extract<ChartSpec, { type: "bar" }>): string {
  const { x0, y1: yBottom, w } = plotArea();
  const n = spec.values.length;
  if (n === 0) return "";
  const lo = Math.min(0, ...spec.values);
  const hi = Math.max(0, ...spec.values);
  const ticks = niceTicks(lo, hi, 5);
  const sy = yScale(ticks[0] as number, ticks[ticks.length - 1] as number);
  const band = w / n;
  const barW = Math.min(band * 0.62, 90);

  let bars = "";
  const positions: number[] = [];
  spec.values.forEach((v, i) => {
    const cx = x0 + band * i + band / 2;
    positions.push(cx);
    const zero = sy(Math.max(ticks[0] as number, 0));
    const top = sy(v);
    const y = Math.min(top, zero);
    const h = Math.max(2, Math.abs(zero - top));
    const cls = i === spec.highlightIndex ? "bar hot" : "bar";
    bars += `<rect class="${cls}" x="${r1(cx - barW / 2)}" y="${r1(y)}" width="${r1(barW)}" height="${r1(h)}" rx="4" style="--i:${i}"/>`;
    bars += `<text class="val" x="${r1(cx)}" y="${r1(y - 8)}" text-anchor="middle" style="--i:${i}">${escapeHtml(fmtNum(v))}</text>`;
  });

  return (
    svgOpen("bars") +
    gridAndAxis(ticks, sy) +
    bars +
    xLabels(spec.categories, positions, 9) +
    `<text class="axis-label" x="${x0}" y="16">${escapeHtml(short(spec.label, 44))}</text>` +
    `<line class="grid zero" x1="${x0}" y1="${r1(sy(0))}" x2="${W - PAD.right}" y2="${r1(sy(0))}"/>` +
    `</svg>`
  );
}

// ── Scatter ────────────────────────────────────────────────────────────────

function scatterSvg(spec: Extract<ChartSpec, { type: "scatter" }>): string {
  const { x0, y1: yBottom, w } = plotArea();
  const pts = spec.points;
  if (pts.length === 0) return "";
  const xsv = pts.map((p) => p.x);
  const ysv = pts.map((p) => p.y);
  const xTicks = niceTicks(Math.min(...xsv), Math.max(...xsv), 5);
  const yTicks = niceTicks(Math.min(...ysv), Math.max(...ysv), 5);
  const xLo = xTicks[0] as number;
  const xHi = xTicks[xTicks.length - 1] as number;
  const sy = yScale(yTicks[0] as number, yTicks[yTicks.length - 1] as number);
  const sx = (v: number) => x0 + ((v - xLo) / (xHi - xLo || 1)) * w;

  let dots = "";
  pts.forEach((p, i) => {
    dots += `<circle class="dot" cx="${r1(sx(p.x))}" cy="${r1(sy(p.y))}" r="4.5" style="--i:${Math.min(i, 60)}"/>`;
  });

  let fit = "";
  if (spec.fit) {
    const yA = spec.fit.slope * xLo + spec.fit.intercept;
    const yB = spec.fit.slope * xHi + spec.fit.intercept;
    fit = `<line class="trend" x1="${r1(sx(xLo))}" y1="${r1(sy(yA))}" x2="${r1(sx(xHi))}" y2="${r1(sy(yB))}"/>`;
  }

  let xAxis = "";
  for (const t of xTicks) {
    xAxis += `<text class="tick" x="${r1(sx(t))}" y="${yBottom + 24}" text-anchor="middle">${escapeHtml(fmtNum(t))}</text>`;
  }

  return (
    svgOpen("scatter") +
    gridAndAxis(yTicks, sy) +
    fit +
    dots +
    xAxis +
    `<text class="axis-label" x="${x0}" y="16">${escapeHtml(short(spec.yLabel, 28))} vs ${escapeHtml(short(spec.xLabel, 28))}</text>` +
    `<text class="badge" x="${W - PAD.right}" y="16" text-anchor="end">r = ${spec.r.toFixed(2)}</text>` +
    `</svg>`
  );
}

// ── Donut ──────────────────────────────────────────────────────────────────

function donutSvg(spec: Extract<ChartSpec, { type: "donut" }>): string {
  const cx = 240;
  const cy = H / 2 + 6;
  const rOuter = 150;
  const rInner = 92;
  const total = spec.slices.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) return "";

  let angle = -Math.PI / 2;
  let paths = "";
  let legend = "";
  spec.slices.forEach((s, i) => {
    const frac = Math.max(0, s.value) / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    // Leave a hairline gap between slices.
    const gap = Math.min(0.02, frac / 4);
    paths += `<path class="slice s${i % 6}" d="${donutArc(cx, cy, rInner, rOuter, a0 + gap, a1 - gap)}" style="--i:${i}"/>`;
    const ly = 96 + i * 52;
    legend += `<rect class="slice s${i % 6}" x="470" y="${ly - 14}" width="18" height="18" rx="4" style="--i:${i}"/>`;
    legend += `<text class="legend" x="500" y="${ly}">${escapeHtml(short(s.label, 20))}</text>`;
    legend += `<text class="legend-val" x="500" y="${ly + 20}">${escapeHtml(fmtNum(s.value))} · ${(frac * 100).toFixed(1)}%</text>`;
  });

  return (
    svgOpen("donut") +
    paths +
    `<text class="donut-center" x="${cx}" y="${cy - 4}" text-anchor="middle">${escapeHtml(fmtNum(total))}</text>` +
    `<text class="donut-sub" x="${cx}" y="${cy + 22}" text-anchor="middle">total</text>` +
    legend +
    `<text class="axis-label" x="24" y="16">${escapeHtml(short(spec.label, 46))}</text>` +
    `</svg>`
  );
}

function donutArc(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  if (a1 <= a0) a1 = a0 + 0.001;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${r1(cx + r * Math.cos(a))},${r1(cy + r * Math.sin(a))}`;
  return (
    `M${p(rOut, a0)} ` +
    `A${rOut},${rOut} 0 ${large} 1 ${p(rOut, a1)} ` +
    `L${p(rIn, a1)} ` +
    `A${rIn},${rIn} 0 ${large} 0 ${p(rIn, a0)} Z`
  );
}
