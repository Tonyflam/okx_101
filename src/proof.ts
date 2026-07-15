// ── Cryptographic proof bundles ────────────────────────────────────────────
// Every story ships evidence that can be verified WITHOUT trusting this
// server: SHA-256 hashes of the inputs and outputs, signed with a persistent
// Ed25519 key. Offline check: recompute storySha256 from the story JSON
// (minus `proof`), then verify the signature with the embedded public key.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProofBundle, StorySpec } from "./types.js";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively (arrays keep order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const inner = (v as Record<string, unknown>)[k];
      if (inner !== undefined) out[k] = sortValue(inner);
    }
    return out;
  }
  return v;
}

// ── Signer ─────────────────────────────────────────────────────────────────

export interface ProofSigner {
  privateKey: KeyObject;
  /** base64 SPKI DER */
  publicKey: string;
}

/**
 * Load the signing key: PROOF_SIGNING_KEY env (base64 PKCS8 DER) if set,
 * otherwise a key persisted in the data dir (generated on first boot so the
 * server keeps one identity across restarts).
 */
export function loadSigner(dataDir: string): ProofSigner {
  const env = process.env.PROOF_SIGNING_KEY?.trim();
  if (env) {
    const privateKey = createPrivateKey({ key: Buffer.from(env, "base64"), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: publicKeyB64(privateKey) };
  }
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, "proof-key.pkcs8.b64");
  if (existsSync(keyPath)) {
    const privateKey = createPrivateKey({
      key: Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
    return { privateKey, publicKey: publicKeyB64(privateKey) };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  writeFileSync(keyPath, der.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return { privateKey, publicKey: publicKeyB64(privateKey) };
}

function publicKeyB64(privateKey: KeyObject): string {
  const pub = createPublicKey(privateKey);
  return (pub.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
}

// ── Build & verify ─────────────────────────────────────────────────────────

/** The exact bytes the Ed25519 signature covers. */
function signedPayload(p: Omit<ProofBundle, "signature">): Buffer {
  return Buffer.from(
    canonicalJson({
      version: p.version,
      engine: p.engine,
      algorithm: p.algorithm,
      csvSha256: p.csvSha256,
      factsSha256: p.factsSha256,
      storySha256: p.storySha256,
      publicKey: p.publicKey,
    }),
    "utf8",
  );
}

export function buildProof(csv: string, spec: StorySpec, signer: ProofSigner, engine: string): ProofBundle {
  const { proof: _drop, ...specSansProof } = spec;
  const base: Omit<ProofBundle, "signature"> = {
    version: 1,
    engine,
    algorithm: "ed25519",
    csvSha256: sha256Hex(Buffer.from(csv, "utf8")),
    factsSha256: sha256Hex(canonicalJson(spec.facts)),
    storySha256: sha256Hex(canonicalJson(specSansProof)),
    publicKey: signer.publicKey,
  };
  const signature = edSign(null, signedPayload(base), signer.privateKey).toString("base64");
  return { ...base, signature };
}

export interface ProofCheck {
  ok: boolean;
  detail: string;
}

/** Verify hashes + signature of a story spec's embedded proof (no recompute). */
export function verifyProof(spec: StorySpec, csv?: string): ProofCheck {
  const proof = spec.proof;
  if (!proof) return { ok: false, detail: "No proof bundle embedded in this story." };
  const { proof: _drop, ...specSansProof } = spec;
  const storySha = sha256Hex(canonicalJson(specSansProof));
  if (storySha !== proof.storySha256) {
    return { ok: false, detail: `Story content hash mismatch: spec was modified after signing (expected ${proof.storySha256.slice(0, 16)}…, got ${storySha.slice(0, 16)}…).` };
  }
  const factsSha = sha256Hex(canonicalJson(spec.facts));
  if (factsSha !== proof.factsSha256) {
    return { ok: false, detail: "Fact ledger hash mismatch: facts were modified after signing." };
  }
  if (csv !== undefined) {
    const csvSha = sha256Hex(Buffer.from(csv, "utf8"));
    if (csvSha !== proof.csvSha256) {
      return { ok: false, detail: `Dataset hash mismatch: the provided CSV is not the file this story was generated from (expected ${proof.csvSha256.slice(0, 16)}…, got ${csvSha.slice(0, 16)}…).` };
    }
  }
  let sigOk = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(proof.publicKey, "base64"), format: "der", type: "spki" });
    const { signature, ...rest } = proof;
    sigOk = edVerify(null, signedPayload(rest), pub, Buffer.from(signature, "base64"));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, detail: "Ed25519 signature is invalid for this proof bundle." };
  return { ok: true, detail: `Hashes match and Ed25519 signature verifies (engine ${proof.engine}).` };
}
