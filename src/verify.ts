// ── Independent story verification ─────────────────────────────────────────
// Given the original dataset and a story spec, re-run the ENTIRE deterministic
// analysis and check every layer:
//   1. proof signature (pinned trusted keys) + hashes → TAMPERED / SOURCE_MISMATCH
//   2. every fact reproduces exactly                   → TAMPERED
//   3. every scene's claim is bound to its fact: structured fields
//      field-by-field, prose numbers, direction words, metric names
//                                                      → UNSUPPORTED_CLAIM
// A missing proof or missing structured claims caps the verdict at
// LEGACY_UNVERIFIED — stripping protections is never a path to VERIFIED.
// This is what makes Plotline useful to other agents: trust is checkable,
// not asserted.

import { parseCsv } from "./csv.js";
import { extractFacts } from "./insights.js";
import { auditClaimText, claimDiff, claimFromFact, extractNumbers, factAllowedNumbers, forbiddenMetricsFor } from "./narrative.js";
import { sha256Hex, verifyProof } from "./proof.js";
import type { Fact, StorySpec, VerifyCheck, VerifyReport, VerifyVerdict } from "./types.js";

const NUM_TOLERANCE = 1e-6;

export function verifyStory(
  csv: string,
  spec: StorySpec,
  engine: string,
  trustedKeys: readonly string[],
): VerifyReport {
  const checks: VerifyCheck[] = [];
  let sourceMismatch = false;
  let tampered = false;
  let unsupported = false;
  let legacy = false;

  // ── Layer 1: cryptographic proof ─────────────────────────────────────────
  if (spec.proof) {
    const csvSha = sha256Hex(Buffer.from(csv, "utf8"));
    const csvOk = csvSha === spec.proof.csvSha256;
    checks.push({
      name: "dataset-hash",
      ok: csvOk,
      detail: csvOk
        ? `SHA-256 of the provided CSV matches the signed proof (${csvSha.slice(0, 16)}…).`
        : `The provided CSV is NOT the dataset this story was generated from (expected ${spec.proof.csvSha256.slice(0, 16)}…, got ${csvSha.slice(0, 16)}…).`,
    });
    if (!csvOk) sourceMismatch = true;

    const sig = verifyProof(spec, trustedKeys);
    checks.push({ name: "proof-signature", ok: sig.ok, detail: sig.detail });
    if (!sig.ok) tampered = true;
  } else {
    checks.push({
      name: "proof-signature",
      ok: false,
      detail:
        "No proof bundle embedded — a story without a trusted signed proof can NEVER be VERIFIED (best verdict: LEGACY_UNVERIFIED). Current-version Plotline stories always embed one; its absence means the story is old or the proof was stripped.",
    });
    legacy = true;
  }

  // ── Layer 2: every fact must reproduce from the raw data ────────────────
  let factsChecked = 0;
  let freshById: Map<string, Fact> | null = null;
  let datasetColumns: string[] = [];
  if (!sourceMismatch) {
    let recomputed: Fact[] | null = null;
    try {
      const dataset = parseCsv(csv, spec.dataset.name);
      // Only numeric columns are "metrics" — axis/categorical names (month,
      // region…) legitimately appear in prose about other measures.
      datasetColumns = dataset.columns.filter((c) => c.type === "number").map((c) => c.name);
      recomputed = extractFacts(dataset, spec.question);
    } catch (err) {
      checks.push({
        name: "facts-reproduce",
        ok: false,
        detail: `Could not re-analyze the CSV: ${err instanceof Error ? err.message : "parse error"}.`,
      });
      tampered = true;
    }
    if (recomputed) {
      const byId = new Map(recomputed.map((f) => [f.id, f]));
      freshById = byId;
      const failures: string[] = [];
      for (const claimed of spec.facts) {
        factsChecked++;
        const fresh = byId.get(claimed.id);
        const diff = fresh ? factDiff(claimed, fresh) : "no fact with this id reproduces from the data";
        if (diff) failures.push(`${claimed.id}: ${diff}`);
      }
      checks.push({
        name: "facts-reproduce",
        ok: failures.length === 0,
        detail:
          failures.length === 0
            ? `All ${factsChecked} facts recomputed from the raw data and matched exactly (statements, values, methods).`
            : `${failures.length}/${factsChecked} facts do NOT reproduce: ${failures.slice(0, 3).join(" · ")}${failures.length > 3 ? ` · +${failures.length - 3} more` : ""}`,
      });
      if (failures.length > 0) tampered = true;
    }
  }

  // ── Layer 3: every scene claim must be supported by its bound fact ──────
  // 3a. structured fields (metric/unit/period/category/operation/direction)
  //     are re-derived from the RECOMPUTED fact and compared field-by-field;
  // 3b. prose is audited against the bound fact: numbers, direction words,
  //     AND metric names — naming any other dataset column is a forgery.
  let claimsChecked = 0;
  if (!sourceMismatch) {
    const factById = new Map(spec.facts.map((f) => [f.id, f]));
    const failures: string[] = [];
    const sceneFactIds = new Set<string>();
    let missingClaims = 0;
    for (const scene of spec.scenes) {
      if (scene.kind !== "insight") continue;
      claimsChecked++;
      const ids = scene.factIds ?? [];
      const bound = ids.map((id) => factById.get(id)).filter((f): f is Fact => Boolean(f));
      if (bound.length === 0) {
        failures.push(`scene "${truncate(scene.headline, 40)}": bound to no known fact`);
        continue;
      }
      for (const id of ids) sceneFactIds.add(id);
      // 3a. Structured claim: verify each field against the recomputed fact.
      if (scene.claim) {
        const fresh = freshById?.get(scene.claim.factId);
        if (!fresh) {
          failures.push(`scene "${truncate(scene.headline, 40)}": claim references fact ${scene.claim.factId} which does not reproduce`);
          continue;
        }
        const diff = claimDiff(scene.claim, claimFromFact(fresh));
        if (diff) {
          failures.push(`scene "${truncate(scene.headline, 40)}": claim field mismatch — ${diff}`);
          continue;
        }
      } else {
        missingClaims++;
      }
      // 3b. Prose audit against the bound fact (numbers, direction, metric names).
      const text = `${scene.headline} ${scene.body}`;
      const results = bound.map((f) => auditClaimText(f, text, undefined, forbiddenMetricsFor(f, datasetColumns)));
      const anyOk = results.some((r) => r.ok);
      if (!anyOk) {
        const reason = results[0]?.reason ?? "claim not supported";
        failures.push(`scene "${truncate(scene.headline, 40)}": ${reason}`);
      }
    }
    checks.push({
      name: "claims-present",
      ok: missingClaims === 0,
      detail:
        missingClaims === 0
          ? `All ${claimsChecked} insight scenes carry structured, field-verifiable claims.`
          : `${missingClaims}/${claimsChecked} insight scenes lack structured claims — current-version stories always embed them; this story can NEVER be VERIFIED (best verdict: LEGACY_UNVERIFIED).`,
    });
    if (missingClaims > 0) legacy = true;
    // Hero + closing: numbers must come from scene facts or structural counts.
    const structuralOk = auditPeripheral(spec, factById, sceneFactIds);
    if (!structuralOk.ok) failures.push(structuralOk.detail);
    checks.push({
      name: "claims-supported",
      ok: failures.length === 0,
      detail:
        failures.length === 0
          ? `All ${claimsChecked} scene claims are numerically and directionally supported by their bound facts.`
          : `${failures.length} unsupported claim(s): ${failures.slice(0, 3).join(" · ")}${failures.length > 3 ? ` · +${failures.length - 3} more` : ""}`,
    });
    if (failures.length > 0) unsupported = true;
  }

  const verdict: VerifyVerdict = sourceMismatch
    ? "SOURCE_MISMATCH"
    : tampered
      ? "TAMPERED"
      : unsupported
        ? "UNSUPPORTED_CLAIM"
        : legacy
          ? "LEGACY_UNVERIFIED"
          : "VERIFIED";

  return { verdict, checks, engine, storyId: spec.id, factsChecked, claimsChecked };
}

// ── Fact comparison ────────────────────────────────────────────────────────

function factDiff(claimed: Fact, fresh: Fact): string | null {
  if (claimed.kind !== fresh.kind) return `kind "${claimed.kind}" ≠ recomputed "${fresh.kind}"`;
  if (claimed.statement !== fresh.statement) return `statement differs from recomputation`;
  if (claimed.headline !== fresh.headline) return `headline differs from recomputation`;
  if (JSON.stringify(claimed.columns) !== JSON.stringify(fresh.columns)) return `columns differ`;
  const keys = new Set([...Object.keys(claimed.values), ...Object.keys(fresh.values)]);
  for (const k of keys) {
    const a = claimed.values[k];
    const b = fresh.values[k];
    if (typeof a !== "number" || typeof b !== "number") return `value "${k}" missing on one side`;
    const scale = Math.max(1, Math.abs(b));
    if (Math.abs(a - b) / scale > NUM_TOLERANCE) return `value "${k}": claimed ${a}, recomputed ${b}`;
  }
  return null;
}

// ── Hero/closing audit ─────────────────────────────────────────────────────

function auditPeripheral(
  spec: StorySpec,
  factById: Map<string, Fact>,
  sceneFactIds: Set<string>,
): { ok: boolean; detail: string } {
  const allowed = new Set<number>([0, 1, 2, 3]);
  for (let y = 1990; y <= 2035; y++) allowed.add(y);
  allowed.add(spec.dataset.rowCount);
  allowed.add(spec.facts.length);
  allowed.add(spec.scenes.length);
  allowed.add(Math.max(0, spec.scenes.length - 2)); // insight-scene count used in subtitles
  // Numbers quoted from the user's own question are attributed, not claimed.
  if (spec.question) for (const n of extractNumbers(spec.question)) allowed.add(n);
  for (const id of sceneFactIds) {
    const f = factById.get(id);
    if (f) for (const v of factAllowedNumbers(f)) allowed.add(v);
  }
  const texts: string[] = [];
  for (const scene of spec.scenes) {
    if (scene.kind === "hero") texts.push(`${scene.headline} ${scene.sub}`);
    if (scene.kind === "closing") texts.push(`${scene.headline} ${scene.body}`);
  }
  texts.push(`${spec.title} ${spec.subtitle}`);
  for (const text of texts) {
    for (const n of extractNumbers(text)) {
      let hit = false;
      for (const a of allowed) {
        const abs = Math.abs(a);
        if (Math.abs(n - abs) <= 0.05 || (abs > 0 && Math.abs(n - abs) / abs <= 0.015)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        return { ok: false, detail: `title/hero/closing: number ${n} is not backed by any fact used in the story` };
      }
    }
  }
  return { ok: true, detail: "" };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
