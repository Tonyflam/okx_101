// ── Pure statistics primitives — deterministic, no I/O ────────────────────

export interface Descriptives {
  n: number;
  min: number;
  max: number;
  sum: number;
  mean: number;
  median: number;
  stdev: number;
  q1: number;
  q3: number;
}

export function describe(xs: number[]): Descriptives {
  const v = xs.filter(Number.isFinite);
  const n = v.length;
  if (n === 0) return { n: 0, min: NaN, max: NaN, sum: 0, mean: NaN, median: NaN, stdev: NaN, q1: NaN, q3: NaN };
  const sorted = [...v].sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    sum,
    mean,
    median: quantileSorted(sorted, 0.5),
    stdev: Math.sqrt(variance),
    q1: quantileSorted(sorted, 0.25),
    q3: quantileSorted(sorted, 0.75),
  };
}

export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

// ── Regression ─────────────────────────────────────────────────────────────

export interface Regression {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

/** OLS y = slope*x + intercept over paired finite values. */
export function linearRegression(xs: number[], ys: number[]): Regression {
  const pairs: [number, number][] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? (pairs[0]?.[1] ?? 0) : 0, r2: 0, n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pairs) {
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r2: 0, n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  let ssRes = 0;
  for (const [x, y] of pairs) ssRes += (y - (slope * x + intercept)) ** 2;
  const r2 = ssTot <= 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2, n };
}

// ── Statistical inference (t-distribution, exact via incomplete beta) ──────

/** Lanczos log-gamma. */
function logGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += (g[i] as number) / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regIncBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for a t statistic with df degrees of freedom. */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return regIncBeta(df / 2, 0.5, df / (df + t * t));
}

/** Approximate two-sided 97.5% t critical value (Cornish–Fisher expansion). */
function tCrit975(df: number): number {
  const z = 1.959963985;
  if (df <= 0) return z;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

export interface RegressionInference {
  slope: number;
  stderr: number;
  t: number;
  /** Two-sided p-value for H0: slope = 0. */
  p: number;
  /** 95% confidence interval on the slope. */
  ci95: [number, number];
  df: number;
}

/** Slope inference for OLS y = a + bx. Needs n ≥ 3 and x variance > 0. */
export function regressionInference(xs: number[], ys: number[]): RegressionInference | null {
  const pairs: [number, number][] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 3) return null;
  const reg = linearRegression(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  let sxx = 0;
  let ssRes = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    ssRes += (y - (reg.slope * x + reg.intercept)) ** 2;
  }
  if (sxx === 0) return null;
  const df = n - 2;
  const s2 = ssRes / Math.max(1, df);
  const stderr = Math.sqrt(s2 / sxx);
  const t = stderr === 0 ? (reg.slope === 0 ? 0 : Infinity) : reg.slope / stderr;
  const p = stderr === 0 ? (reg.slope === 0 ? 1 : 0) : tTwoSidedP(Math.abs(t), df);
  const crit = tCrit975(df);
  return { slope: reg.slope, stderr, t, p, ci95: [reg.slope - crit * stderr, reg.slope + crit * stderr], df };
}

/** Two-sided p-value for Pearson r under H0: ρ = 0. */
export function pearsonPValue(r: number, n: number): number {
  if (n < 3) return 1;
  const rr = Math.min(0.999999, Math.abs(r));
  if (rr >= 1) return 0;
  const t = rr * Math.sqrt((n - 2) / (1 - rr * rr));
  return tTwoSidedP(t, n - 2);
}

/** Welch's t-test between two samples. */
export function welchT(a: number[], b: number[]): { t: number; df: number; p: number } | null {
  const va = a.filter(Number.isFinite);
  const vb = b.filter(Number.isFinite);
  if (va.length < 3 || vb.length < 3) return null;
  const ma = va.reduce((x, y) => x + y, 0) / va.length;
  const mb = vb.reduce((x, y) => x + y, 0) / vb.length;
  const sa2 = va.reduce((x, y) => x + (y - ma) ** 2, 0) / (va.length - 1);
  const sb2 = vb.reduce((x, y) => x + (y - mb) ** 2, 0) / (vb.length - 1);
  const se2 = sa2 / va.length + sb2 / vb.length;
  if (se2 === 0) return null;
  const t = (ma - mb) / Math.sqrt(se2);
  const df =
    se2 ** 2 /
    ((sa2 / va.length) ** 2 / (va.length - 1) + (sb2 / vb.length) ** 2 / (vb.length - 1));
  return { t, df, p: tTwoSidedP(Math.abs(t), df) };
}

/** Pearson correlation coefficient over paired finite values. */
export function pearson(xs: number[], ys: number[]): { r: number; n: number } {
  const pairs: [number, number][] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 3) return { r: 0, n };
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
  const my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return { r: 0, n };
  return { r: num / Math.sqrt(dx * dy), n };
}

// ── Outliers (modified z-score, MAD-based) ─────────────────────────────────

export interface Outlier {
  index: number;
  value: number;
  score: number; // |modified z|
}

export function outliersMAD(xs: number[], threshold = 3.5): Outlier[] {
  const finite = xs.map((v, i) => ({ v, i })).filter((p) => Number.isFinite(p.v));
  if (finite.length < 8) return [];
  const values = finite.map((p) => p.v).sort((a, b) => a - b);
  const med = quantileSorted(values, 0.5);
  const absDev = finite.map((p) => Math.abs(p.v - med)).sort((a, b) => a - b);
  const mad = quantileSorted(absDev, 0.5);
  if (mad === 0) return [];
  const out: Outlier[] = [];
  for (const p of finite) {
    const score = Math.abs((0.6745 * (p.v - med)) / mad);
    if (score > threshold) out.push({ index: p.i, value: p.v, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ── Changepoint (single mean-shift via binary segmentation) ────────────────

export interface Changepoint {
  index: number; // first index of the second segment
  meanBefore: number;
  meanAfter: number;
  /** Effect size: |Δmean| / pooled stdev. */
  strength: number;
}

export function changepoint(xs: number[]): Changepoint | null {
  const v = xs.filter(Number.isFinite);
  const n = v.length;
  if (n < 10) return null;
  const total = v.reduce((a, b) => a + b, 0);
  let bestIdx = -1;
  let bestGain = 0;
  let leftSum = 0;
  const globalMean = total / n;
  let sse = v.reduce((a, b) => a + (b - globalMean) ** 2, 0);
  if (sse === 0) return null;
  for (let i = 3; i <= n - 3; i++) {
    leftSum += v[i - 1] as number;
    const rightSum = total - leftSum;
    const ml = leftSum / i;
    const mr = rightSum / (n - i);
    // Between-group sum of squares gained by splitting at i.
    const gain = i * (ml - globalMean) ** 2 + (n - i) * (mr - globalMean) ** 2;
    if (gain > bestGain) {
      bestGain = gain;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const before = v.slice(0, bestIdx);
  const after = v.slice(bestIdx);
  const mb = before.reduce((a, b) => a + b, 0) / before.length;
  const ma = after.reduce((a, b) => a + b, 0) / after.length;
  const pooledVar =
    (before.reduce((a, b) => a + (b - mb) ** 2, 0) + after.reduce((a, b) => a + (b - ma) ** 2, 0)) /
    Math.max(1, n - 2);
  const pooled = Math.sqrt(pooledVar);
  if (pooled === 0) return null;
  const strength = Math.abs(ma - mb) / pooled;
  if (strength < 0.8) return null; // not story-worthy
  return { index: bestIdx, meanBefore: mb, meanAfter: ma, strength };
}

// ── Streaks ────────────────────────────────────────────────────────────────

export interface Streak {
  direction: "up" | "down";
  start: number;
  length: number; // number of consecutive moves
  changePct: number;
}

export function longestStreak(xs: number[]): Streak | null {
  const v = xs.filter(Number.isFinite);
  if (v.length < 5) return null;
  let best: Streak | null = null;
  let dir: "up" | "down" | null = null;
  let start = 0;
  let len = 0;
  const consider = (d: "up" | "down", s: number, l: number) => {
    if (l < 3) return;
    const from = v[s] as number;
    const to = v[s + l] as number;
    const changePct = from === 0 ? 0 : ((to - from) / Math.abs(from)) * 100;
    if (!best || l > best.length) best = { direction: d, start: s, length: l, changePct };
  };
  for (let i = 1; i < v.length; i++) {
    const d: "up" | "down" | null = (v[i] as number) > (v[i - 1] as number) ? "up" : (v[i] as number) < (v[i - 1] as number) ? "down" : null;
    if (d !== null && d === dir) {
      len++;
    } else {
      if (dir) consider(dir, start, len);
      dir = d;
      start = i - 1;
      len = d ? 1 : 0;
    }
  }
  if (dir) consider(dir, start, len);
  return best;
}
