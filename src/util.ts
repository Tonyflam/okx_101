import { randomBytes } from "node:crypto";

// ── Escaping ───────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape for attribute contexts (same charset, kept separate for intent). */
export const escapeAttr = escapeHtml;

// ── IDs ────────────────────────────────────────────────────────────────────

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newStoryId(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += ID_ALPHABET[(bytes[i] as number) % 36];
  return out;
}

export function isValidStoryId(id: string): boolean {
  return /^[a-z0-9]{10}$/.test(id);
}

// ── Number formatting ──────────────────────────────────────────────────────

/** Human formatting: 1234567 -> "1.23M", 0.03456 -> "0.0346", 42 -> "42". */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return trimZeros((n / 1e9).toFixed(2)) + "B";
  if (abs >= 1e6) return trimZeros((n / 1e6).toFixed(2)) + "M";
  if (abs >= 1e4) return trimZeros((n / 1e3).toFixed(1)) + "K";
  if (abs >= 100) return trimZeros(n.toFixed(1));
  if (abs >= 1) return trimZeros(n.toFixed(2));
  if (abs === 0) return "0";
  return trimZeros(n.toPrecision(3));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Format with sign: "+12.4%" / "-3.1%". */
export function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n)}%`;
}

/** Format an epoch-ms date as a compact label. */
export function fmtDate(ms: number, granularity: "day" | "month" | "year" = "day"): string {
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[d.getUTCMonth()];
  if (granularity === "year") return String(d.getUTCFullYear());
  if (granularity === "month") return `${m} ${d.getUTCFullYear()}`;
  return `${m} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Choose date label granularity from a range in ms. */
export function dateGranularity(spanMs: number): "day" | "month" | "year" {
  const days = spanMs / 86_400_000;
  if (days > 900) return "year";
  if (days > 120) return "month";
  return "day";
}

// ── Misc ───────────────────────────────────────────────────────────────────

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

/** "nice" axis ticks (loose): returns tick values covering [min,max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const span = niceNum(max - min, false);
  const step = niceNum(span / (count - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(round12(v));
  return ticks;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice: number;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else {
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
  }
  return nice * Math.pow(10, exp);
}

function round12(n: number): number {
  return Number(n.toPrecision(12));
}
