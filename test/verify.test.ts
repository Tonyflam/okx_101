// ── Adversarial verification suite ─────────────────────────────────────────
// verify_story must catch exactly the forgeries a plausible-but-lying report
// would contain: reversed trends, swapped numbers, invented percentages,
// tampered facts, and swapped source datasets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { createStory } from "../src/pipeline.js";
import { verifyStory } from "../src/verify.js";
import { buildProof, verifyProof, sha256Hex, canonicalJson } from "../src/proof.js";
import { auditClaimText, factDirection } from "../src/narrative.js";
import { regressionInference, pearsonPValue, welchT, tTwoSidedP } from "../src/stats.js";
import type { InsightScene, ProofBundle, StorySpec } from "../src/types.js";
import type { ProofSigner } from "../src/proof.js";

const ENGINE = "plotline@test";

const CSV = [
  "month,revenue,costs",
  "2024-01,100,80",
  "2024-02,130,90",
  "2024-03,170,100",
  "2024-04,150,105",
  "2024-05,220,115",
  "2024-06,290,130",
  "2024-07,340,150",
  "2024-08,420,170",
].join("\n");

function testSigner(): ProofSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).toString("base64");
  return { privateKey, publicKey };
}

// The "Plotline instance" key for this suite — pinned as trusted.
const SIGNER = testSigner();
const TRUSTED = [SIGNER.publicKey];

async function makeStory(): Promise<StorySpec> {
  const result = await createStory(
    { csv: CSV, datasetName: "adversarial test" },
    { baseUrl: "http://test.example", save: () => {}, signer: SIGNER, engine: ENGINE },
  );
  return result.spec;
}

const clone = (spec: StorySpec): StorySpec => JSON.parse(JSON.stringify(spec)) as StorySpec;

// ── Happy path ──────────────────────────────────────────────────────────────

test("verify_story: untouched story verifies end-to-end", async () => {
  const spec = await makeStory();
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "VERIFIED");
  assert.ok(report.factsChecked >= 3);
  assert.ok(report.claimsChecked >= 3);
  assert.ok(report.checks.every((c) => c.ok));
});

test("every insight scene carries a structured, field-verifiable claim", async () => {
  const spec = await makeStory();
  const insights = spec.scenes.filter((s): s is InsightScene => s.kind === "insight");
  assert.ok(insights.length >= 3);
  for (const s of insights) {
    assert.ok(s.claim, `scene "${s.headline}" must carry a claim`);
    assert.equal(s.claim!.factId, s.factIds[0]);
    assert.ok(s.claim!.metric.length > 0);
    assert.ok(s.claim!.operation.length > 0);
    assert.ok(s.claim!.unit.length > 0);
  }
});

test("proof bundle: hashes + Ed25519 signature verify", async () => {
  const spec = await makeStory();
  assert.ok(spec.proof, "story must embed a proof bundle");
  const check = verifyProof(spec, TRUSTED, CSV);
  assert.ok(check.ok, check.detail);
  assert.equal(spec.proof!.csvSha256, sha256Hex(Buffer.from(CSV, "utf8")));
});

// ── Forgeries the demo shows ────────────────────────────────────────────────

test("adversarial: reversed trend direction → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find(
    (s): s is InsightScene => s.kind === "insight" && factDirection(spec.facts.find((f) => f.id === s.factIds[0])!) === "up",
  );
  assert.ok(scene, "needs an upward scene");
  // The lie keeps every number identical — only the direction flips
  // (headline AND body, as a real forgery would).
  const flip = (s: string) =>
    s
      .replace(/\bclimbing\b/gi, "falling")
      .replace(/\bclimb\b/gi, "decline")
      .replace(/\bmoved from\b/i, "fell from")
      .replace(/\brise\b/gi, "fall")
      .replace(/\bgains\b/gi, "declines")
      .replace(/\bincreases\b/gi, "decreases");
  scene.headline = flip(scene.headline);
  scene.body = flip(scene.body);
  if (!/fell|fall|declin|decreas/i.test(`${scene.headline} ${scene.body}`)) {
    scene.body = `It fell sharply. ${scene.body}`;
  }
  // Strip proof + structured claim so we exercise the prose layer in isolation.
  delete spec.proof;
  delete scene.claim;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
  const claims = report.checks.find((c) => c.name === "claims-supported");
  assert.ok(claims && !claims.ok && /decline|increase/i.test(claims.detail));
});

// ── Structured claim fields: each field is verified against the recompute ──

test("adversarial: forged claim.direction field → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find(
    (s): s is InsightScene => s.kind === "insight" && s.claim?.direction === "up",
  );
  assert.ok(scene, "needs an upward claim");
  scene.claim!.direction = "down";
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
  const claims = report.checks.find((c) => c.name === "claims-supported");
  assert.ok(claims && !claims.ok && /direction/i.test(claims.detail));
});

test("adversarial: forged claim.metric (swapped column) → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find(
    (s): s is InsightScene => s.kind === "insight" && s.claim?.metric === "revenue",
  );
  assert.ok(scene, "needs a revenue-metric claim");
  scene.claim!.metric = "costs";
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
  const claims = report.checks.find((c) => c.name === "claims-supported");
  assert.ok(claims && !claims.ok && /metric/i.test(claims.detail));
});

test("adversarial: forged claim.period → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find(
    (s): s is InsightScene => s.kind === "insight" && Boolean(s.claim?.period),
  );
  assert.ok(scene, "needs a period-bearing claim");
  scene.claim!.period = { from: "2019-01", to: "2019-12" };
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
  const claims = report.checks.find((c) => c.name === "claims-supported");
  assert.ok(claims && !claims.ok && /period/i.test(claims.detail));
});

test("adversarial: forged claim.operation/unit → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find((s): s is InsightScene => s.kind === "insight" && Boolean(s.claim));
  assert.ok(scene);
  scene.claim!.operation = "mean_shift";
  scene.claim!.unit = "pearson-r";
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
});

test("adversarial: invented percentage → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scene = spec.scenes.find((s): s is InsightScene => s.kind === "insight");
  assert.ok(scene);
  scene.body += " Margins expanded 47.3% in the same window.";
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
});

test("adversarial: number swapped in from a different fact → UNSUPPORTED_CLAIM", async () => {
  const spec = await makeStory();
  const scenes = spec.scenes.filter((s): s is InsightScene => s.kind === "insight");
  assert.ok(scenes.length >= 2);
  const donor = spec.facts.find((f) => f.id === scenes[1]!.factIds[0])!;
  const donorNum = Object.values(donor.values).find((v) => v > 12 && Number.isFinite(v));
  assert.ok(donorNum !== undefined, "needs a distinctive donor number");
  scenes[0]!.body += ` The figure reached ${donorNum} at its height.`;
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  // The donor number belongs to another fact — the per-scene binding must reject it
  // (unless by coincidence it also exists in the bound fact's values).
  const bound = spec.facts.find((f) => f.id === scenes[0]!.factIds[0])!;
  const inBound = Object.values(bound.values).some((v) => Math.abs(v - donorNum) < 0.05);
  if (!inBound) assert.equal(report.verdict, "UNSUPPORTED_CLAIM");
});

test("adversarial: tampered fact value → TAMPERED", async () => {
  const spec = await makeStory();
  const fact = spec.facts.find((f) => f.kind === "trend")!;
  fact.values.changePct = (fact.values.changePct ?? 0) * 2; // double the growth
  delete spec.proof;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "TAMPERED");
  const facts = report.checks.find((c) => c.name === "facts-reproduce");
  assert.ok(facts && !facts.ok && facts.detail.includes("changePct"));
});

test("adversarial: modified source dataset → SOURCE_MISMATCH", async () => {
  const spec = await makeStory();
  const doctored = CSV.replace("420", "990"); // change one cell
  const report = verifyStory(doctored, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "SOURCE_MISMATCH");
  const hash = report.checks.find((c) => c.name === "dataset-hash");
  assert.ok(hash && !hash.ok);
});

test("adversarial: spec edited after signing → TAMPERED (signature catches it)", async () => {
  const spec = await makeStory();
  spec.title = "Totally legitimate unedited story";
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "TAMPERED");
  const sig = report.checks.find((c) => c.name === "proof-signature");
  assert.ok(sig && !sig.ok);
});

test("adversarial: fully consistent re-sign with attacker's key → TAMPERED (key not pinned)", async () => {
  const spec = await makeStory();
  spec.title = "Edited story";
  // The strongest forgery: attacker recomputes ALL hashes over the edited spec
  // and signs with their own key. Every hash and the signature are internally
  // consistent — only key pinning catches it.
  const attacker = testSigner();
  const { proof: _old, ...sansProof } = spec;
  spec.proof = buildProof(CSV, sansProof as StorySpec, attacker, ENGINE);
  assert.ok(verifyProof(spec, [attacker.publicKey], CSV).ok, "forgery must be internally consistent");
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "TAMPERED");
  const sig = report.checks.find((c) => c.name === "proof-signature");
  assert.ok(sig && !sig.ok && /trusted/i.test(sig.detail));
});

test("adversarial: forged proof with attacker's own key still fails (story hash mismatch)", async () => {
  const spec = await makeStory();
  spec.title = "Edited story";
  // Attacker re-signs with their own key but reuses stale hashes.
  const attacker = testSigner();
  const stale = clone(spec);
  const forged: ProofBundle = { ...buildProof(CSV, stale, attacker, ENGINE), storySha256: spec.proof!.storySha256 };
  spec.proof = forged;
  const report = verifyStory(CSV, spec, ENGINE, TRUSTED);
  assert.equal(report.verdict, "TAMPERED");
});

// ── Claim auditor unit behavior ─────────────────────────────────────────────

test("auditClaimText: direction contradiction fails, faithful prose passes", async () => {
  const spec = await makeStory();
  const up = spec.facts.find((f) => factDirection(f) === "up")!;
  const lie = auditClaimText(up, `${up.columns[0]} declined steadily across the period.`);
  assert.equal(lie.ok, false);
  assert.match(lie.reason ?? "", /decline/i);
  const truth = auditClaimText(up, up.statement);
  assert.ok(truth.ok);
});

test("auditClaimText: the 0–12 freebie is gone", async () => {
  const spec = await makeStory();
  const fact = spec.facts.find((f) => f.kind === "trend")!;
  const has7 = Object.values(fact.values).some((v) => Math.abs(v - 7) < 0.05) || /(^|[^\d.])7([^\d.]|$)/.test(fact.statement);
  if (!has7) {
    const r = auditClaimText(fact, "Growth continued for 7 straight quarters.");
    assert.equal(r.ok, false, "unbacked small integers must now fail the audit");
  }
});

// ── Statistical inference primitives ────────────────────────────────────────

test("regressionInference: strong linear series → tight CI, tiny p", () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const ys = xs.map((x) => 3 + 2 * x + (x % 2 === 0 ? 0.1 : -0.1));
  const inf = regressionInference(xs, ys)!;
  assert.ok(Math.abs(inf.slope - 2) < 0.05);
  assert.ok(inf.p < 0.001);
  assert.ok(inf.ci95[0] < 2 && 2 < inf.ci95[1]);
});

test("pearsonPValue: r=0.9 n=20 significant; r=0.3 n=5 not", () => {
  assert.ok(pearsonPValue(0.9, 20) < 0.001);
  assert.ok(pearsonPValue(0.3, 5) > 0.05);
});

test("welchT: separated samples significant, identical samples not", () => {
  const a = [1, 1.1, 0.9, 1.05, 0.95, 1.02];
  const b = [5, 5.1, 4.9, 5.05, 4.95, 5.02];
  const sep = welchT(a, b)!;
  assert.ok(sep.p < 0.001);
  const same = welchT(a, [...a])!;
  assert.ok(same.p > 0.9);
});

test("tTwoSidedP sanity: t=0 → p=1; huge t → p≈0", () => {
  assert.ok(Math.abs(tTwoSidedP(0, 10) - 1) < 1e-9);
  assert.ok(tTwoSidedP(50, 10) < 1e-6);
});

test("canonicalJson: key order does not change the hash", () => {
  const a = canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] });
  const b = canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
});
