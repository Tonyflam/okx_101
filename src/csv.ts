import type { Cell, Column, ColumnType, Dataset } from "./types.js";

const MAX_ROWS = 20_000;
const MAX_COLS = 60;

/**
 * Robust CSV parsing: quoted fields, escaped quotes, CRLF, BOM,
 * delimiter sniffing (, ; tab |), per-column type inference.
 */
export function parseCsv(text: string, name = "dataset"): Dataset {
  const notes: string[] = [];
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // BOM
  src = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!src) throw new Error("CSV is empty.");

  const delimiter = sniffDelimiter(src);
  const grid = tokenize(src, delimiter);
  if (grid.length < 2) {
    throw new Error("CSV needs a header row and at least one data row.");
  }

  const headerRaw = grid[0] as string[];
  const width = Math.min(headerRaw.length, MAX_COLS);
  if (headerRaw.length > MAX_COLS) notes.push(`Only the first ${MAX_COLS} columns were analyzed.`);

  const header = headerRaw.slice(0, width).map((h, i) => (h.trim() ? h.trim() : `column_${i + 1}`));

  let body = grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  if (body.length > MAX_ROWS) {
    notes.push(`Dataset truncated to the first ${MAX_ROWS.toLocaleString()} rows (of ${body.length.toLocaleString()}).`);
    body = body.slice(0, MAX_ROWS);
  }
  if (body.length === 0) throw new Error("CSV has no data rows.");

  // Infer a type per column from all values.
  const types: ColumnType[] = [];
  for (let c = 0; c < width; c++) {
    types.push(inferType(body.map((r) => (r[c] ?? "").trim())));
  }

  const rows: Cell[][] = body.map((r) => {
    const out: Cell[] = [];
    for (let c = 0; c < width; c++) {
      out.push(coerce((r[c] ?? "").trim(), types[c] as ColumnType));
    }
    return out;
  });

  const columns: Column[] = header.map((n, i) => ({ name: n, type: types[i] as ColumnType }));
  return { name, columns, rows, notes };
}

// ── Delimiter sniffing ─────────────────────────────────────────────────────

function sniffDelimiter(src: string): string {
  const firstLines = src.split("\n").slice(0, 5);
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = firstLines.map((l) => countOutsideQuotes(l, d));
    const min = Math.min(...counts);
    const consistent = counts.every((c) => c === counts[0]) ? 2 : 0;
    const score = min * 2 + consistent;
    if (min > 0 && score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ch && !inQ) n++;
  }
  return n;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(src: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

// ── Type inference ─────────────────────────────────────────────────────────

const BOOL_TRUE = new Set(["true", "yes", "y", "1"]);
const BOOL_FALSE = new Set(["false", "no", "n", "0"]);

function inferType(values: string[]): ColumnType {
  let num = 0;
  let date = 0;
  let bool = 0;
  let nonEmpty = 0;
  for (const v of values) {
    if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v.toLowerCase() === "n/a") continue;
    nonEmpty++;
    if (parseNumber(v) !== null) num++;
    if (parseDate(v) !== null) date++;
    const lower = v.toLowerCase();
    if (BOOL_TRUE.has(lower) || BOOL_FALSE.has(lower)) bool++;
  }
  if (nonEmpty === 0) return "string";
  // Dates beat numbers only when values are not plain numerics (e.g. "2024-01-05").
  if (date / nonEmpty >= 0.9 && num / nonEmpty < 0.9) return "date";
  if (num / nonEmpty >= 0.9) return "number";
  if (bool / nonEmpty >= 0.95) return "boolean";
  if (date / nonEmpty >= 0.9) return "date";
  return "string";
}

function coerce(v: string, t: ColumnType): Cell {
  if (v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "na" || v.toLowerCase() === "n/a") return null;
  switch (t) {
    case "number":
      return parseNumber(v);
    case "date":
      return parseDate(v);
    case "boolean": {
      const lower = v.toLowerCase();
      if (BOOL_TRUE.has(lower)) return true;
      if (BOOL_FALSE.has(lower)) return false;
      return null;
    }
    default:
      return v;
  }
}

/** Accepts "1,234.5", "$42", "12%", "(3.4)" (negative), "1_000". */
export function parseNumber(v: string): number | null {
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^[$€£¥₮]/, "").replace(/%$/, "").replace(/[,_\s]/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Epoch ms, or null. Accepts ISO dates, "MM/DD/YYYY", "DD-MM-YYYY", "Jan 2024", "2024-Q1". */
export function parseDate(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  // Reject plain numbers (avoid treating 2021.5 or 42 as a date).
  if (/^[+-]?\d*\.?\d+$/.test(s)) {
    // Allow a bare year 1900..2100.
    if (/^\d{4}$/.test(s)) {
      const y = Number(s);
      if (y >= 1900 && y <= 2100) return Date.UTC(y, 0, 1);
    }
    return null;
  }
  // ISO and near-ISO
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T\s].*)?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = m[3] ? Number(m[3]) : 1;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return Date.UTC(y, mo - 1, d);
    return null;
  }
  // Quarters: 2024-Q1 / Q1 2024
  m = s.match(/^(\d{4})[-\s]?Q([1-4])$/i) ?? s.match(/^Q([1-4])[-\s](\d{4})$/i);
  if (m) {
    const a = m[1] ?? "";
    const b = m[2] ?? "";
    const y = Number(a.length === 4 ? a : b);
    const q = Number(a.length === 4 ? b : a);
    return Date.UTC(y, (q - 1) * 3, 1);
  }
  // MM/DD/YYYY or DD/MM/YYYY (assume MM/DD unless first part > 12)
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    let mo = Number(m[1]);
    let d = Number(m[2]);
    const y = Number(m[3]);
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return Date.UTC(y, mo - 1, d);
    return null;
  }
  // Month-name formats: "Jan 2024", "January 5, 2024", "5 Jan 2024"
  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()];
    if (mo !== undefined) return Date.UTC(Number(m[3]), mo, Number(m[2]));
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[(m[2] as string).slice(0, 3).toLowerCase()];
    if (mo !== undefined) return Date.UTC(Number(m[3]), mo, Number(m[1]));
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()];
    if (mo !== undefined) return Date.UTC(Number(m[2]), mo, 1);
  }
  return null;
}
