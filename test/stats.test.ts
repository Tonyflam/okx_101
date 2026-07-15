import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, linearRegression, pearson, outliersMAD, changepoint, longestStreak } from "../src/stats.js";

test("describe computes correct summary", () => {
  const d = describe([1, 2, 3, 4, 5]);
  assert.equal(d.mean, 3);
  assert.equal(d.median, 3);
  assert.equal(d.min, 1);
  assert.equal(d.max, 5);
  assert.ok(Math.abs(d.stdev - Math.sqrt(2.5)) < 1e-9);
});

test("linearRegression recovers a known slope", () => {
  const xs = [0, 1, 2, 3, 4];
  const ys = [2, 4, 6, 8, 10]; // y = 2x + 2
  const r = linearRegression(xs, ys);
  assert.ok(Math.abs(r.slope - 2) < 1e-9);
  assert.ok(Math.abs(r.intercept - 2) < 1e-9);
  assert.ok(Math.abs(r.r2 - 1) < 1e-9);
});

test("pearson detects perfect inverse correlation", () => {
  const { r } = pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.ok(Math.abs(r + 1) < 1e-9);
});

test("pearson returns r=0 for constant series", () => {
  const { r } = pearson([1, 1, 1, 1], [2, 3, 4, 5]);
  assert.equal(r, 0);
});

test("outliersMAD flags a clear outlier", () => {
  const values = [10, 11, 10, 12, 11, 10, 12, 11, 95, 10, 11, 12];
  const out = outliersMAD(values);
  assert.ok(out.length >= 1);
  assert.equal(out[0]!.index, 8);
  assert.ok(out[0]!.score > 3.5);
});

test("outliersMAD returns empty for uniform data", () => {
  assert.deepEqual(outliersMAD([5, 5, 5, 5, 5, 5, 5, 5, 5]), []);
});

test("changepoint finds a structural break", () => {
  const series = [10, 11, 10, 12, 11, 10, 11, 50, 52, 51, 53, 50, 52, 51];
  const cp = changepoint(series);
  assert.ok(cp !== null);
  assert.equal(cp.index, 7);
  assert.ok(cp.meanAfter > cp.meanBefore);
});

test("changepoint returns null for stable series", () => {
  const cp = changepoint([10, 10.2, 9.9, 10.1, 10, 9.8, 10.2, 10, 10.1, 9.9, 10, 10.1]);
  assert.equal(cp, null);
});

test("longestStreak finds consecutive rises", () => {
  const s = longestStreak([5, 4, 5, 6, 7, 8, 9, 10, 3, 2])!;
  assert.ok(s !== null);
  assert.equal(s.direction, "up");
  assert.equal(s.length, 6); // 4→5→6→7→8→9→10 is 6 consecutive up moves
});
