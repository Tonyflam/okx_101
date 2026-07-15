import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";
import { extractFacts } from "../src/insights.js";
import { deterministicNarrative, selectSceneFacts, extractNumbers, auditText } from "../src/narrative.js";
import type { Fact } from "../src/types.js";

const CSV = `month,mrr,churn
2024-01,42000,4.8
2024-02,42900,4.7
2024-03,43800,4.6
2024-04,44700,4.5
2024-05,45600,4.4
2024-06,46800,4.3
2024-07,47700,4.2
2024-08,48900,4.1
2024-09,50100,3.9
2024-10,54600,3.7
2024-11,59700,3.4
2024-12,65400,3.2`;

function facts(): Fact[] {
  return extractFacts(parseCsv(CSV, "test data"));
}

test("extractFacts finds trend, correlation and overview", () => {
  const fs = facts();
  const kinds = new Set(fs.map((f) => f.kind));
  assert.ok(kinds.has("overview"));
  assert.ok(kinds.has("trend"));
  assert.ok(kinds.has("correlation"));
  // ids are sequential and unique
  const ids = fs.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  // sorted by importance descending
  for (let i = 1; i < fs.length; i++) {
    assert.ok(fs[i - 1]!.importance >= fs[i]!.importance);
  }
});

test("selectSceneFacts respects caps and ordering", () => {
  const sel = selectSceneFacts(facts());
  assert.ok(sel.length >= 3 && sel.length <= 7);
  const perKind = new Map<string, number>();
  for (const f of sel) perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
  for (const [, n] of perKind) assert.ok(n <= 2);
});

test("deterministicNarrative builds hero, insights, closing", () => {
  const fs = facts();
  const sel = selectSceneFacts(fs);
  const n = deterministicNarrative(fs, sel, { datasetName: "test data", rowCount: 12, tone: "documentary" });
  assert.equal(n.scenes[0]!.kind, "hero");
  assert.equal(n.scenes[n.scenes.length - 1]!.kind, "closing");
  assert.equal(n.scenes.length, sel.length + 2);
  assert.ok(n.title.length > 0);
});

test("extractNumbers pulls numeric tokens", () => {
  const nums = extractNumbers("Revenue rose 162.9% from 42,000 to 110400 in 18 months");
  assert.ok(nums.includes(162.9));
  assert.ok(nums.includes(42000));
  assert.ok(nums.includes(110400));
  assert.ok(nums.includes(18));
});

test("auditText verifies allowed numbers and rejects fabricated ones", () => {
  const allowed = new Set([162.9, 42000, 110400, 18]);
  const auditA = { checked: 0, verified: 0, rewritten: 0 };
  const good = auditText("It grew 162.9% — from 42,000 to 110400 over 18 points.", allowed, auditA);
  assert.equal(good, true);
  assert.equal(auditA.checked, 4);
  assert.equal(auditA.verified, 4);
  const auditB = { checked: 0, verified: 0, rewritten: 0 };
  const bad = auditText("It grew 999% in 7 weeks.", allowed, auditB);
  assert.equal(bad, false);
});

test("auditText allows tolerance for rounding", () => {
  const allowed = new Set([162.87]);
  const a1 = { checked: 0, verified: 0, rewritten: 0 };
  assert.equal(auditText("about 162.9%", allowed, a1), true); // within 1.5% relative
  const a2 = { checked: 0, verified: 0, rewritten: 0 };
  assert.equal(auditText("about 170%", allowed, a2), false);
});
