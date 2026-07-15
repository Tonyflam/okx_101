import { test } from "node:test";
import assert from "node:assert/strict";
import { createStory, analyzeCsv, UserError } from "../src/pipeline.js";
import { buildStoryHtml } from "../src/renderer.js";
import type { StorySpec } from "../src/types.js";

const CSV = `date,close,volume
2025-04-01,42.1,132
2025-04-02,42.4,141
2025-04-03,41.9,128
2025-04-04,42.6,155
2025-04-05,42.3,147
2025-04-06,42.8,138
2025-04-07,42.5,150
2025-04-08,43.0,144
2025-04-09,42.7,136
2025-04-10,42.2,129
2025-04-11,52.9,890
2025-04-12,53.1,720`;

function deps() {
  const saved: { spec: StorySpec; html: string }[] = [];
  return {
    saved,
    baseUrl: "https://plotline.test",
    save: (spec: StorySpec, html: string) => saved.push({ spec, html }),
  };
}

test("createStory produces a complete story end-to-end", async () => {
  const d = deps();
  const result = await createStory({ csv: CSV, question: "what happened to price?" }, d);
  assert.ok(result.url.startsWith("https://plotline.test/story/"));
  assert.ok(result.spec.facts.length >= 2);
  assert.ok(result.spec.scenes.length >= 4);
  assert.equal(result.spec.narrativeMode, "deterministic"); // no LLM key in tests
  assert.equal(d.saved.length, 1);
  // Every insight scene must reference facts that exist in the ledger
  const ids = new Set(result.spec.facts.map((f) => f.id));
  for (const s of result.spec.scenes) {
    if (s.kind === "insight") for (const fid of s.factIds) assert.ok(ids.has(fid));
  }
});

test("createStory rejects empty and oversized input", async () => {
  const d = deps();
  await assert.rejects(() => createStory({ csv: "" }, d), UserError);
  await assert.rejects(() => createStory({ csv: "x".repeat(2 * 1024 * 1024 + 1) }, d), UserError);
});

test("createStory rejects data with no numeric signal", async () => {
  const d = deps();
  await assert.rejects(() => createStory({ csv: "a,b\nx,y\nz,w" }, d), UserError);
});

test("analyzeCsv returns facts without charts", () => {
  const a = analyzeCsv(CSV, undefined, "prices");
  assert.equal(a.dataset.name, "prices");
  assert.ok(a.facts.length >= 2);
  assert.ok(!("chart" in a.facts[0]!));
});

test("rendered HTML is self-contained and escaped", async () => {
  const d = deps();
  const evil = `name,value
<script>alert(1)</script>,10
"quote""inside",20
normal,30
alpha,40
beta,50`;
  const result = await createStory({ csv: evil, datasetName: '<img src=x onerror=alert(1)>' }, d);
  const html = result.html;
  // no unescaped script tag from data (only our runtime <script> at the end)
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;") || !html.includes("alert(1)"));
  // self-contained: no external URLs in src/href except our own routes
  assert.ok(!/src="https?:\/\//.test(html));
  assert.ok(!/<link[^>]+href="https?:\/\//.test(html));
});

test("story page includes fact ledger and audit line", async () => {
  const d = deps();
  const result = await createStory({ csv: CSV }, d);
  assert.ok(result.html.includes("The fact ledger"));
  assert.ok(result.html.includes("Deterministic narration"));
  assert.ok(result.html.includes(result.spec.facts[0]!.id));
});

test("buildStoryHtml renders all three themes", async () => {
  const d = deps();
  for (const theme of ["midnight", "paper", "neon"] as const) {
    const r = await createStory({ csv: CSV, theme }, d);
    assert.ok(r.html.includes(`theme-${theme}`));
  }
});
