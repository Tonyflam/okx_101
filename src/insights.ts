import type { Cell, ChartSpec, Column, Dataset, Fact } from "./types.js";
import {
  changepoint,
  describe,
  linearRegression,
  longestStreak,
  outliersMAD,
  pearson,
  pearsonPValue,
  regressionInference,
  welchT,
} from "./stats.js";
import { clamp, dateGranularity, fmtDate, fmtNum, fmtPct, truncate } from "./util.js";

const MAX_LINE_POINTS = 120;
const MAX_BAR_CATS = 8;

interface SeriesPoint {
  label: string;
  value: number;
  row: number;
}

interface Axis {
  kind: "date" | "label" | "index";
  column?: string;
  /** label for row i */
  labelAt(row: number): string;
  /** sortable value for row i (epoch ms for dates, row index otherwise) */
  orderAt(row: number): number;
}

/**
 * Scan a dataset and produce a ranked ledger of deterministic facts.
 * Every number in every fact is computed here — never by an LLM.
 */
export function extractFacts(ds: Dataset, question?: string): Fact[] {
  const facts: Fact[] = [];
  let seq = 0;
  const nextId = () => `F${++seq}`;

  const numericCols = ds.columns.filter((c) => c.type === "number" && !looksLikeId(c.name));
  const stringCols = ds.columns.filter((c) => c.type === "string");
  const axis = pickAxis(ds);
  const sorted = sortRowsByAxis(ds, axis);

  // ── Overview ─────────────────────────────────────────────────────────────
  {
    const spanText = axisSpanText(ds, axis, sorted);
    facts.push({
      id: nextId(),
      kind: "overview",
      headline: "The dataset",
      statement:
        `The dataset "${ds.name}" holds ${ds.rows.length} rows across ${ds.columns.length} columns` +
        (spanText ? `, covering ${spanText}` : "") +
        `.`,
      importance: 10,
      columns: ds.columns.map((c) => c.name),
      values: { rows: ds.rows.length, columns: ds.columns.length },
      evidence: `Parsed ${ds.rows.length} rows × ${ds.columns.length} columns.`,
    });
  }

  // ── Per-numeric-column series facts ──────────────────────────────────────
  const rankedNumeric = rankNumericColumns(ds, numericCols, question);
  for (const col of rankedNumeric.slice(0, 6)) {
    const series = buildSeries(ds, sorted, axis, col.name);
    if (series.length < 3) continue;
    const values = series.map((p) => p.value);
    const d = describe(values);

    // Trend + delta
    if (series.length >= 5) {
      const reg = linearRegression(series.map((_, i) => i), values);
      const inf = regressionInference(series.map((_, i) => i), values);
      const first = values[0] as number;
      const last = values[values.length - 1] as number;
      const pct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
      const dir = pct > 3 ? "up" : pct < -3 ? "down" : "flat";
      const strong = reg.r2 >= 0.55;
      const chart = lineChart(col.name, axis, series, { slope: reg.slope, intercept: reg.intercept });
      let importance: number;
      let headline: string;
      let statement: string;
      if (dir === "flat") {
        importance = 24;
        headline = `${col.name} holds steady`;
        statement = `${col.name} is broadly flat: from ${fmtNum(first)} to ${fmtNum(last)} (${fmtPct(pct)}) across ${series.length} points, averaging ${fmtNum(d.mean)}.`;
      } else {
        importance = clamp(48 + Math.min(30, Math.abs(pct) / 4) + reg.r2 * 18, 0, 96);
        headline = `${col.name} is ${dir === "up" ? "climbing" : "falling"}`;
        statement =
          `${col.name} moved from ${fmtNum(first)} to ${fmtNum(last)} — ${fmtPct(pct)} across ${series.length} points` +
          (strong ? `, a ${dir === "up" ? "consistent climb" : "steady decline"} (R² ${reg.r2.toFixed(2)})` : `, though the path was uneven (R² ${reg.r2.toFixed(2)})`) +
          `.`;
      }
      facts.push({
        id: nextId(),
        kind: "trend",
        headline,
        statement,
        importance: boost(importance, [col.name], question),
        columns: [col.name],
        values: { first, last, changePct: round2(pct), r2: round2(reg.r2), points: series.length, mean: round2(d.mean) },
        evidence: `OLS regression over ${series.length} points; R²=${reg.r2.toFixed(2)}.`,
        sourceRows: capRows(series.map((p) => p.row)),
        confidence: inf ? trendConfidence(inf, series.length) : undefined,
        period: seriesPeriod(series),
        chart,
      });
    }

    // Changepoint
    const cp = changepoint(values);
    if (cp) {
      const shiftPct = cp.meanBefore !== 0 ? ((cp.meanAfter - cp.meanBefore) / Math.abs(cp.meanBefore)) * 100 : 0;
      const at = series[cp.index]?.label ?? `point ${cp.index + 1}`;
      const dir = cp.meanAfter > cp.meanBefore ? "jumped" : "dropped";
      const wt = welchT(values.slice(0, cp.index), values.slice(cp.index));
      const significant = wt !== null && wt.p < 0.05;
      facts.push({
        id: nextId(),
        kind: "changepoint",
        headline: `Something changed at ${at}`,
        statement:
          `Around ${at}, the average level of ${col.name} ${dir} from ${fmtNum(cp.meanBefore)} to ${fmtNum(cp.meanAfter)} (${fmtPct(shiftPct)}) — a sustained level shift of ${cp.strength.toFixed(1)} pooled standard deviations` +
          (significant ? `, statistically significant (Welch p=${fmtP(wt.p)})` : wt ? `, though the sample is small (Welch p=${fmtP(wt.p)})` : "") +
          `.`,
        importance: boost(clamp(46 + cp.strength * 9, 0, 90), [col.name], question),
        columns: [col.name],
        values: { before: round2(cp.meanBefore), after: round2(cp.meanAfter), shiftPct: round2(shiftPct), effectSize: round2(cp.strength) },
        evidence: `Mean-shift detection (binary segmentation), effect size ${cp.strength.toFixed(2)} pooled SDs` + (wt ? `; Welch t-test p=${fmtP(wt.p)}` : "") + `.`,
        sourceRows: capRows(series.map((p) => p.row)),
        confidence: wt
          ? {
              level: wt.p < 0.01 && cp.strength >= 1.5 ? "high" : wt.p < 0.05 ? "medium" : "low",
              note: `Welch t-test across the split: p=${fmtP(wt.p)}, effect size ${cp.strength.toFixed(2)} pooled SDs.`,
              pValue: roundP(wt.p),
            }
          : { level: "low", note: "Segments too short for a significance test; effect size only." },
        period: seriesPeriod(series),
        chart: lineChart(col.name, axis, series, undefined, cp.index),
      });
    }

    // Outlier
    const outs = outliersMAD(values);
    if (outs.length > 0) {
      const o = outs[0]!;
      const at = series[o.index]?.label ?? `point ${o.index + 1}`;
      const vsMedian = d.median !== 0 ? (o.value / d.median) : 0;
      facts.push({
        id: nextId(),
        kind: "outlier",
        headline: `The ${at} anomaly`,
        statement:
          `${col.name} hit ${fmtNum(o.value)} at ${at} — ${vsMedian !== 0 ? `${fmtNum(vsMedian)}× the median of ${fmtNum(d.median)}` : `far from the median ${fmtNum(d.median)}`}, an outlier with modified z-score ${o.score.toFixed(1)}` +
          (outs.length > 1 ? ` (one of ${outs.length} anomalies found)` : "") +
          `.`,
        importance: boost(clamp(40 + o.score * 4, 0, 82), [col.name], question),
        columns: [col.name],
        values: { value: round2(o.value), median: round2(d.median), zScore: round2(o.score), anomalies: outs.length },
        evidence: `MAD-based modified z-score ${o.score.toFixed(2)} (threshold 3.5), n=${values.length}.`,
        sourceRows: series[o.index] ? [series[o.index]!.row] : undefined,
        confidence: {
          level: o.score >= 5 ? "high" : "medium",
          note: `Modified z-score ${o.score.toFixed(1)} (robust to the outlier itself); threshold 3.5.`,
        },
        period: seriesPeriod(series),
        chart: lineChart(col.name, axis, series, undefined, o.index),
      });
    }

    // Streak
    const st = longestStreak(values);
    if (st && st.length >= 4) {
      facts.push({
        id: nextId(),
        kind: "streak",
        headline: `${st.length} straight ${st.direction === "up" ? "gains" : "declines"}`,
        statement: `${col.name} logged ${st.length} consecutive ${st.direction === "up" ? "increases" : "decreases"} starting at ${series[st.start]?.label ?? `point ${st.start + 1}`}, moving ${fmtPct(st.changePct)} over the run.`,
        importance: boost(clamp(24 + st.length * 3, 0, 58), [col.name], question),
        columns: [col.name],
        values: { length: st.length, changePct: round2(st.changePct) },
        evidence: `Longest monotonic run: ${st.length} steps.`,
        sourceRows: capRows(series.slice(st.start, st.start + st.length + 1).map((p) => p.row)),
        period: seriesPeriod(series.slice(st.start, st.start + st.length + 1)),
      });
    }

    // Volatility (only when meaningful and not already trending hard)
    if (d.mean !== 0 && values.length >= 8) {
      const cv = Math.abs(d.stdev / d.mean);
      if (cv > 0.45) {
        facts.push({
          id: nextId(),
          kind: "volatility",
          headline: `${col.name} runs hot and cold`,
          statement: `${col.name} is volatile: it swings between ${fmtNum(d.min)} and ${fmtNum(d.max)} around a mean of ${fmtNum(d.mean)} (coefficient of variation ${cv.toFixed(2)}).`,
          importance: boost(clamp(28 + cv * 18, 0, 62), [col.name], question),
          columns: [col.name],
          values: { min: round2(d.min), max: round2(d.max), mean: round2(d.mean), cv: round2(cv) },
          evidence: `CV = stdev/|mean| = ${cv.toFixed(2)}, n=${values.length}.`,
        });
      }
    }

    // Extreme (peak)
    {
      const peakIdx = values.indexOf(d.max);
      const at = series[peakIdx]?.label ?? `point ${peakIdx + 1}`;
      facts.push({
        id: nextId(),
        kind: "extreme",
        headline: `Peak ${col.name}`,
        statement: `${col.name} peaked at ${fmtNum(d.max)} (${at}); the low was ${fmtNum(d.min)}. Total across the dataset: ${fmtNum(d.sum)}.`,
        importance: boost(20, [col.name], question),
        columns: [col.name],
        values: { max: round2(d.max), min: round2(d.min), sum: round2(d.sum) },
        evidence: `Max/min over ${values.length} points. Exact computation.`,
        sourceRows: series[peakIdx] ? [series[peakIdx]!.row] : undefined,
      });
    }

    // Seasonality by weekday/month (needs date axis)
    const seasonal = seasonalFact(ds, sorted, axis, col.name, nextId, question);
    if (seasonal) facts.push(seasonal);
  }

  // ── Correlations ─────────────────────────────────────────────────────────
  const corrCols = rankedNumeric.slice(0, 8);
  for (let i = 0; i < corrCols.length; i++) {
    for (let j = i + 1; j < corrCols.length; j++) {
      const a = corrCols[i]!;
      const b = corrCols[j]!;
      const pair = alignedPairs(ds, a.name, b.name);
      const { r, n } = pearson(pair.map((p) => p[0]), pair.map((p) => p[1]));
      if (Math.abs(r) >= 0.55 && n >= 6) {
        const reg = linearRegression(pair.map((p) => p[0]), pair.map((p) => p[1]));
        const pv = pearsonPValue(r, n);
        const strength = Math.abs(r) >= 0.85 ? "a near lockstep" : Math.abs(r) >= 0.7 ? "a strong" : "a moderate";
        facts.push({
          id: nextId(),
          kind: "correlation",
          headline: `${a.name} moves with ${b.name}`,
          statement: `${a.name} and ${b.name} show ${strength} ${r > 0 ? "positive" : "inverse"} relationship (r ${r.toFixed(2)} across ${n} paired points)${r < 0 ? " — when one rises, the other tends to fall" : ""}.`,
          importance: boost(clamp(34 + Math.abs(r) * 44, 0, 86), [a.name, b.name], question),
          columns: [a.name, b.name],
          values: { r: round2(r), n },
          evidence: `Pearson r=${r.toFixed(3)}, n=${n}, p=${fmtP(pv)}. Correlation is not causation.`,
          sourceRows: capRows(pair.map((p) => p[2])),
          confidence: {
            level: pv < 0.01 && n >= 10 ? "high" : pv < 0.05 ? "medium" : "low",
            note: `p=${fmtP(pv)} for H0: ρ=0 (n=${n}). Correlation, not causation${n < 10 ? "; small sample" : ""}.`,
            pValue: roundP(pv),
          },
          chart: {
            type: "scatter",
            xLabel: a.name,
            yLabel: b.name,
            points: downsamplePairs(pair, 200).map(([x, y]) => ({ x, y })),
            fit: { slope: reg.slope, intercept: reg.intercept },
            r,
          },
        });
      }
    }
  }

  // ── Category analysis ────────────────────────────────────────────────────
  const catCols = stringCols.filter((c) => {
    const card = distinctCount(ds, c.name);
    return card >= 2 && card <= 40 && card < ds.rows.length * 0.8;
  });
  for (const cat of catCols.slice(0, 2)) {
    for (const num of rankedNumeric.slice(0, 2)) {
      const groups = groupSum(ds, cat.name, num.name);
      if (groups.length < 2) continue;
      const total = groups.reduce((a, g) => a + g.sum, 0);
      if (total === 0) continue;
      const top = groups[0]!;
      const share = (top.sum / total) * 100;
      const runner = groups[1]!;
      const lead = runner.sum !== 0 ? top.sum / runner.sum : 0;
      facts.push({
        id: nextId(),
        kind: "category_leader",
        headline: `${truncate(top.key, 40)} leads the pack`,
        statement:
          `Across ${groups.length} ${cat.name} groups, "${truncate(top.key, 40)}" leads ${num.name} with ${fmtNum(top.sum)} — ${fmtNum(share)}% of the total` +
          (lead > 1.15 ? `, ${fmtNum(lead)}× the runner-up "${truncate(runner.key, 40)}" (${fmtNum(runner.sum)})` : `, just ahead of "${truncate(runner.key, 40)}" (${fmtNum(runner.sum)})`) +
          `.`,
        importance: boost(clamp(38 + share * 0.4, 0, 84), [cat.name, num.name], question),
        columns: [cat.name, num.name],
        values: { leader: round2(top.sum), share: round2(share), runnerUp: round2(runner.sum), groups: groups.length, leadRatio: round2(lead) },
        evidence: `Group sums of ${num.name} by ${cat.name}; ${groups.length} groups. Exact computation.`,
        sourceRows: capRows(top.rows),
        category: top.key,
        chart: barChart(`${num.name} by ${cat.name}`, groups, 0),
      });

      // Concentration
      const topN = Math.min(3, groups.length);
      const topShare = (groups.slice(0, topN).reduce((a, g) => a + g.sum, 0) / total) * 100;
      if (groups.length > 4 && topShare > 55) {
        facts.push({
          id: nextId(),
          kind: "concentration",
          headline: `The top ${topN} carry it all`,
          statement: `Concentration is real: the top ${topN} of ${groups.length} ${cat.name} groups account for ${fmtNum(topShare)}% of all ${num.name}.`,
          importance: boost(clamp(34 + topShare * 0.42, 0, 80), [cat.name, num.name], question),
          columns: [cat.name, num.name],
          values: { topShare: round2(topShare), topN, groups: groups.length },
          evidence: `Top-${topN} share of total ${num.name} = ${topShare.toFixed(1)}%. Exact computation.`,
          sourceRows: capRows(groups.slice(0, topN).flatMap((g) => g.rows)),
          chart: donutChart(`${num.name} share by ${cat.name}`, groups),
        });
      }
    }
  }

  // Deduplicate near-identical charts per kind/column and rank.
  return facts.sort((a, b) => b.importance - a.importance);
}

// ── Axis handling ──────────────────────────────────────────────────────────

function pickAxis(ds: Dataset): Axis {
  const dateCol = ds.columns.find((c) => c.type === "date");
  if (dateCol) {
    const idx = colIndex(ds, dateCol.name);
    const vals = ds.rows.map((r) => r[idx]);
    const nonNull = vals.filter((v) => typeof v === "number").length;
    if (nonNull >= ds.rows.length * 0.7) {
      const finiteVals = vals.filter((v): v is number => typeof v === "number");
      const span = Math.max(...finiteVals) - Math.min(...finiteVals);
      const gran = dateGranularity(span);
      return {
        kind: "date",
        column: dateCol.name,
        labelAt: (row) => {
          const v = ds.rows[row]?.[idx];
          return typeof v === "number" ? fmtDate(v, gran) : `row ${row + 1}`;
        },
        orderAt: (row) => {
          const v = ds.rows[row]?.[idx];
          return typeof v === "number" ? v : Number.MAX_SAFE_INTEGER;
        },
      };
    }
  }
  // A label column: string column whose values are mostly unique (e.g. month names in order).
  const labelCol = ds.columns.find((c) => c.type === "string" && distinctCount(ds, c.name) >= ds.rows.length * 0.9);
  if (labelCol) {
    const idx = colIndex(ds, labelCol.name);
    return {
      kind: "label",
      column: labelCol.name,
      labelAt: (row) => {
        const v = ds.rows[row]?.[idx];
        return typeof v === "string" ? v : `row ${row + 1}`;
      },
      orderAt: (row) => row,
    };
  }
  return { kind: "index", labelAt: (row) => `#${row + 1}`, orderAt: (row) => row };
}

function sortRowsByAxis(ds: Dataset, axis: Axis): number[] {
  const order = ds.rows.map((_, i) => i);
  if (axis.kind === "date") order.sort((a, b) => axis.orderAt(a) - axis.orderAt(b));
  return order;
}

function axisSpanText(ds: Dataset, axis: Axis, sorted: number[]): string | null {
  if (axis.kind !== "date" || sorted.length === 0) return null;
  const first = axis.labelAt(sorted[0] as number);
  const last = axis.labelAt(sorted[sorted.length - 1] as number);
  return `${first} to ${last}`;
}

// ── Series / grouping helpers ──────────────────────────────────────────────

function colIndex(ds: Dataset, name: string): number {
  return ds.columns.findIndex((c) => c.name === name);
}

function buildSeries(ds: Dataset, sorted: number[], axis: Axis, colName: string): SeriesPoint[] {
  const idx = colIndex(ds, colName);
  const out: SeriesPoint[] = [];
  for (const row of sorted) {
    const v = ds.rows[row]?.[idx];
    if (typeof v === "number" && Number.isFinite(v)) {
      out.push({ label: axis.labelAt(row), value: v, row });
    }
  }
  return out;
}

function alignedPairs(ds: Dataset, aName: string, bName: string): [number, number, number][] {
  const ai = colIndex(ds, aName);
  const bi = colIndex(ds, bName);
  const out: [number, number, number][] = [];
  for (let row = 0; row < ds.rows.length; row++) {
    const r = ds.rows[row]!;
    const a = r[ai];
    const b = r[bi];
    if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
      out.push([a, b, row]);
    }
  }
  return out;
}

function distinctCount(ds: Dataset, colName: string): number {
  const idx = colIndex(ds, colName);
  const set = new Set<string>();
  for (const r of ds.rows) {
    const v = r[idx];
    if (typeof v === "string" && v !== "") set.add(v);
  }
  return set.size;
}

function groupSum(ds: Dataset, catName: string, numName: string): { key: string; sum: number; count: number; rows: number[] }[] {
  const ci = colIndex(ds, catName);
  const ni = colIndex(ds, numName);
  const map = new Map<string, { sum: number; count: number; rows: number[] }>();
  for (let row = 0; row < ds.rows.length; row++) {
    const r = ds.rows[row]!;
    const k = r[ci];
    const v = r[ni];
    if (typeof k !== "string" || k === "") continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const g = map.get(k) ?? { sum: 0, count: 0, rows: [] };
    g.sum += v;
    g.count++;
    if (g.rows.length < 200) g.rows.push(row);
    map.set(k, g);
  }
  return [...map.entries()]
    .map(([key, g]) => ({ key, sum: g.sum, count: g.count, rows: g.rows }))
    .sort((a, b) => b.sum - a.sum);
}

// ── Seasonality ────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function seasonalFact(
  ds: Dataset,
  sorted: number[],
  axis: Axis,
  colName: string,
  nextId: () => string,
  question?: string,
): Fact | null {
  if (axis.kind !== "date" || !axis.column) return null;
  const dateIdx = colIndex(ds, axis.column);
  const numIdx = colIndex(ds, colName);
  const points: { ms: number; v: number }[] = [];
  for (const row of sorted) {
    const ms = ds.rows[row]?.[dateIdx];
    const v = ds.rows[row]?.[numIdx];
    if (typeof ms === "number" && typeof v === "number" && Number.isFinite(v)) points.push({ ms, v });
  }
  if (points.length < 20) return null;
  const spanDays = (points[points.length - 1]!.ms - points[0]!.ms) / 86_400_000;

  // Daily-ish data over 8+ weeks → weekday pattern; monthly data over 2+ years → month pattern.
  const cadenceDays = spanDays / points.length;
  let names: string[];
  let keyOf: (ms: number) => number;
  let unit: string;
  if (cadenceDays <= 3 && spanDays >= 56) {
    names = WEEKDAYS;
    keyOf = (ms) => new Date(ms).getUTCDay();
    unit = "day of week";
  } else if (cadenceDays >= 20 && spanDays >= 700) {
    names = MONTHS_FULL;
    keyOf = (ms) => new Date(ms).getUTCMonth();
    unit = "month";
  } else {
    return null;
  }

  const buckets = new Map<number, { sum: number; count: number }>();
  for (const p of points) {
    const k = keyOf(p.ms);
    const b = buckets.get(k) ?? { sum: 0, count: 0 };
    b.sum += p.v;
    b.count++;
    buckets.set(k, b);
  }
  const means = [...buckets.entries()]
    .filter(([, b]) => b.count >= 2)
    .map(([k, b]) => ({ k, mean: b.sum / b.count }));
  if (means.length < 4) return null;
  means.sort((a, b) => b.mean - a.mean);
  const best = means[0]!;
  const worst = means[means.length - 1]!;
  if (worst.mean === 0) return null;
  const spread = ((best.mean - worst.mean) / Math.abs(worst.mean)) * 100;
  if (spread < 15) return null;

  const ordered = [...means].sort((a, b) => a.k - b.k);
  return {
    id: nextId(),
    kind: "seasonal",
    headline: `${names[best.k]} is different`,
    statement: `${colName} has a rhythm: it averages ${fmtNum(best.mean)} on ${names[best.k]}s versus ${fmtNum(worst.mean)} on ${names[worst.k]}s — a ${fmtNum(spread)}% gap by ${unit}.`,
    importance: boost(clamp(30 + spread * 0.35, 0, 72), [colName], question),
    columns: [colName],
    values: { best: round2(best.mean), worst: round2(worst.mean), spreadPct: round2(spread) },
    evidence: `Mean of ${colName} grouped by ${unit}; n=${points.length}.`,
    chart: {
      type: "bar",
      label: `${colName} by ${unit}`,
      categories: ordered.map((m) => (names[m.k] as string).slice(0, 3)),
      values: ordered.map((m) => round2(m.mean)),
      highlightIndex: ordered.findIndex((m) => m.k === best.k),
    },
  };
}

// ── Chart builders ─────────────────────────────────────────────────────────

function lineChart(
  yLabel: string,
  axis: Axis,
  series: SeriesPoint[],
  trend?: { slope: number; intercept: number },
  markIndex?: number,
): ChartSpec {
  let pts = series;
  let mark = markIndex;
  if (series.length > MAX_LINE_POINTS) {
    const bucketSize = Math.ceil(series.length / MAX_LINE_POINTS);
    const down: SeriesPoint[] = [];
    let newMark: number | undefined;
    for (let i = 0; i < series.length; i += bucketSize) {
      const bucket = series.slice(i, i + bucketSize);
      const mean = bucket.reduce((a, p) => a + p.value, 0) / bucket.length;
      if (mark !== undefined && mark >= i && mark < i + bucketSize) {
        // Preserve the marked point's true value so the marker is honest.
        const marked = series[mark]!;
        down.push({ label: marked.label, value: marked.value, row: marked.row });
        newMark = down.length - 1;
      } else {
        down.push({ label: bucket[0]!.label, value: mean, row: bucket[0]!.row });
      }
    }
    pts = down;
    mark = newMark;
    if (trend) {
      // Rescale slope to the downsampled index space.
      trend = { slope: trend.slope * bucketSize, intercept: trend.intercept };
    }
  }
  return {
    type: "line",
    xLabel: axis.column ?? "sequence",
    yLabel,
    points: pts.map((p) => ({ x: p.label, y: p.value })),
    trend,
    markIndex: mark,
  };
}

function barChart(label: string, groups: { key: string; sum: number }[], highlightIndex?: number): ChartSpec {
  const top = groups.slice(0, MAX_BAR_CATS);
  const rest = groups.slice(MAX_BAR_CATS);
  const cats = top.map((g) => truncate(g.key, 18));
  const vals = top.map((g) => round2(g.sum));
  if (rest.length > 0) {
    cats.push(`Other (${rest.length})`);
    vals.push(round2(rest.reduce((a, g) => a + g.sum, 0)));
  }
  return { type: "bar", label, categories: cats, values: vals, highlightIndex };
}

function donutChart(label: string, groups: { key: string; sum: number }[]): ChartSpec {
  const top = groups.slice(0, 5);
  const rest = groups.slice(5);
  const slices = top.map((g) => ({ label: truncate(g.key, 18), value: round2(g.sum) }));
  if (rest.length > 0) slices.push({ label: `Other (${rest.length})`, value: round2(rest.reduce((a, g) => a + g.sum, 0)) });
  return { type: "donut", label, slices };
}

// ── Ranking helpers ────────────────────────────────────────────────────────

function rankNumericColumns(ds: Dataset, cols: Column[], question?: string): Column[] {
  const scored = cols.map((c) => {
    const idx = colIndex(ds, c.name);
    const vals = ds.rows.map((r) => r[idx]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const d = describe(vals);
    const cv = d.mean !== 0 ? Math.abs(d.stdev / d.mean) : 0;
    let score = vals.length / Math.max(1, ds.rows.length) + Math.min(cv, 2);
    if (question && mentions(question, c.name)) score += 10;
    return { c, score };
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

function looksLikeId(name: string): boolean {
  return /(^|_)(id|uuid|index|row|#)$/i.test(name.trim()) || /^(id|uuid)$/i.test(name.trim());
}

function mentions(question: string, colName: string): boolean {
  const q = question.toLowerCase();
  const n = colName.toLowerCase();
  if (n.length >= 3 && q.includes(n)) return true;
  // token overlap for snake/space cases
  const tokens = n.split(/[\s_\-/]+/).filter((t) => t.length >= 4);
  return tokens.some((t) => q.includes(t));
}

function boost(importance: number, cols: string[], question?: string): number {
  if (!question) return Math.round(importance);
  const hit = cols.some((c) => mentions(question, c));
  return Math.round(clamp(importance + (hit ? 18 : 0), 0, 100));
}

function downsamplePairs(pairs: [number, number, number][], max: number): [number, number, number][] {
  if (pairs.length <= max) return pairs;
  const step = pairs.length / max;
  const out: [number, number, number][] = [];
  for (let i = 0; i < max; i++) out.push(pairs[Math.floor(i * step)]!);
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cap provenance row lists so specs stay light. */
function capRows(rows: number[]): number[] {
  return rows.length > 200 ? rows.slice(0, 200) : rows;
}

/** Axis span of a series, as displayed labels. */
function seriesPeriod(series: SeriesPoint[]): { from: string; to: string } | undefined {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last) return undefined;
  return { from: first.label, to: last.label };
}

/** Format a p-value honestly: "<0.001" below resolution. */
function fmtP(p: number): string {
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}

function roundP(p: number): number {
  return p < 0.001 ? 0.001 : Math.round(p * 1000) / 1000;
}

function trendConfidence(
  inf: { p: number; ci95: [number, number]; df: number },
  n: number,
): import("./types.js").FactConfidence {
  const level = inf.p < 0.01 && n >= 8 ? "high" : inf.p < 0.05 ? "medium" : "low";
  return {
    level,
    note:
      `95% CI on slope [${round2(inf.ci95[0])}, ${round2(inf.ci95[1])}]; p=${fmtP(inf.p)} (df=${inf.df})` +
      (n < 8 ? "; short series — treat as indicative" : "") +
      `.`,
    ci95: [round2(inf.ci95[0]), round2(inf.ci95[1])],
    pValue: roundP(inf.p),
  };
}
