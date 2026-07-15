import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";

/**
 * x402 monetization layer (OKX X Layer / USDT0).
 *
 * Modes:
 *  - "free"      → every call succeeds; a courtesy quota header shows remaining
 *                  free calls. This is the default so the ASP review and any
 *                  agent can always exercise the service end-to-end.
 *  - "challenge" → after FREE_DAILY calls per day, respond with HTTP 402 + a
 *                  spec-correct x402 v2 challenge (base64 JSON in the
 *                  PAYMENT-REQUIRED response header, mirrored in the body).
 *
 * Settlement: when OKX Developer Portal credentials are configured
 * (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE from
 * https://web3.okx.com/onchainos/dev-portal), X-PAYMENT payloads are verified
 * and settled through the official OKX facilitator
 * (/api/v6/pay/x402/verify + /settle, HMAC-signed — the same client the
 * @okxweb3/x402-express middleware uses). Successful settlements attach the
 * standard PAYMENT-RESPONSE header. Without credentials, paid mode re-issues
 * the challenge with an explicit error — we never pretend to settle.
 */

// USDT0 on OKX X Layer mainnet (eip155:196), 6 decimals.
const XLAYER_NETWORK = "eip155:196";
const USDT0_ADDRESS = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

export interface X402Config {
  mode: "free" | "challenge";
  payTo: string;
  priceUsd: number;
  freeDaily: number;
  baseUrl: string;
}

export function x402ConfigFromEnv(baseUrl: string): X402Config {
  const mode = process.env.X402_MODE === "challenge" ? "challenge" : "free";
  return {
    mode,
    payTo: process.env.X402_PAY_TO ?? "0x0000000000000000000000000000000000000000",
    priceUsd: clampPrice(Number(process.env.X402_PRICE_USD ?? "0.20")),
    freeDaily: Math.max(1, Number(process.env.FREE_DAILY ?? "25") || 25),
    baseUrl,
  };
}

function clampPrice(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0.2;
  return Math.min(p, 100);
}

/** Per-client daily usage meter (in-memory, resets each UTC day). */
export class UsageMeter {
  private counts = new Map<string, number>();
  private day = utcDay();

  hit(clientKey: string): number {
    this.rollover();
    const next = (this.counts.get(clientKey) ?? 0) + 1;
    this.counts.set(clientKey, next);
    return next;
  }

  used(clientKey: string): number {
    this.rollover();
    return this.counts.get(clientKey) ?? 0;
  }

  private rollover(): void {
    const d = utcDay();
    if (d !== this.day) {
      this.day = d;
      this.counts.clear();
    }
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function clientKey(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = typeof fwd === "string" ? (fwd.split(",")[0] ?? "").trim() : req.socket.remoteAddress ?? "unknown";
  return raw || "unknown";
}

export interface PaymentAccept {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface X402Challenge {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentAccept[];
  error?: string;
}

/**
 * Build the standard x402 v2 challenge exactly as specified in the OKX A2MCP
 * guide: top-level `resource` object, `accepts[]` entries with `amount` in
 * minimal units (USDT0, decimals=6), network `eip155:196` (X Layer).
 * Base64 of this JSON goes in the PAYMENT-REQUIRED response header — that
 * header is what the marketplace validates — and the JSON is mirrored in the
 * body (which carries `x402Version`).
 */
export function buildChallenge(cfg: X402Config, resourcePath: string): X402Challenge {
  const atomic = Math.round(cfg.priceUsd * 1e6); // USDT0 has 6 decimals
  return {
    x402Version: 2,
    resource: {
      url: `${cfg.baseUrl}${resourcePath}`,
      description: "Plotline: turn a CSV into a verified, cinematic data story.",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: XLAYER_NETWORK,
        asset: USDT0_ADDRESS,
        amount: String(atomic),
        payTo: cfg.payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD\u20AE0", version: "1" },
      },
    ],
  };
}

/** Attach the challenge to a response: header (validated) + body (mirror). */
export function send402(res: Response, challenge: X402Challenge): void {
  res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"));
  res.status(402).json(challenge);
}

// ── Settlement via the official OKX facilitator ─────────────────────────────

/** Minimal facilitator surface (matches OKXFacilitatorClient; injectable for tests). */
export interface FacilitatorLike {
  verify(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string }>;
}

/**
 * Build the OKX facilitator client from Developer Portal credentials
 * (https://web3.okx.com/onchainos/dev-portal → create project → API key).
 * Returns null when credentials are absent — paid mode then declines honestly.
 */
export function facilitatorFromEnv(): FacilitatorLike | null {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY ?? process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_PASSPHRASE ?? process.env.OKX_API_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) return null;
  // syncSettle: facilitator waits for on-chain confirmation before responding,
  // so a 200 from us always means the payment actually landed.
  return new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    syncSettle: true,
  }) as unknown as FacilitatorLike;
}

export type SettlementOutcome = { ok: true; responseHeader: string } | { ok: false; reason: string };

/**
 * Verify + settle an X-PAYMENT header against this resource's requirements.
 * The requirements are rebuilt from the same challenge we issued, so the
 * facilitator checks the payment against exactly what was quoted.
 */
// ── Replay protection: one X-PAYMENT payload settles exactly once ──────────
// Concurrent duplicates share the same in-flight settlement promise (atomic
// "settle once"); later duplicates within the TTL get the cached outcome
// instead of triggering a second on-chain settlement.
const REPLAY_TTL_MS = 10 * 60 * 1000;
const REPLAY_MAX = 500;
const replayCache = new Map<string, { at: number; result: Promise<SettlementOutcome> }>();

function replayKey(paymentHeader: string, resourcePath: string): string {
  return createHash("sha256").update(paymentHeader).update("|").update(resourcePath).digest("hex");
}

function pruneReplayCache(): void {
  const now = Date.now();
  for (const [k, v] of replayCache) {
    if (now - v.at > REPLAY_TTL_MS) replayCache.delete(k);
  }
  while (replayCache.size > REPLAY_MAX) {
    const oldest = replayCache.keys().next().value;
    if (oldest === undefined) break;
    replayCache.delete(oldest);
  }
}

export async function settlePayment(
  cfg: X402Config,
  facilitator: FacilitatorLike | null,
  paymentHeader: string,
  resourcePath: string,
): Promise<SettlementOutcome> {
  const key = replayKey(paymentHeader, resourcePath);
  const cached = replayCache.get(key);
  if (cached) return cached.result;
  const result = settlePaymentOnce(cfg, facilitator, paymentHeader, resourcePath);
  replayCache.set(key, { at: Date.now(), result });
  pruneReplayCache();
  return result;
}

async function settlePaymentOnce(
  cfg: X402Config,
  facilitator: FacilitatorLike | null,
  paymentHeader: string,
  resourcePath: string,
): Promise<SettlementOutcome> {
  if (!facilitator) {
    return {
      ok: false,
      reason:
        "Payment settlement is not enabled on this deployment: the operator has not configured OKX Developer Portal API credentials (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE).",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "Malformed X-PAYMENT header: expected base64-encoded JSON payment payload." };
  }
  const requirements = buildChallenge(cfg, resourcePath).accepts[0];
  try {
    const verdict = await facilitator.verify(payload, requirements);
    if (!verdict.isValid) {
      return { ok: false, reason: `Payment verification failed: ${verdict.invalidReason ?? "invalid payment"}.` };
    }
    const settled = await facilitator.settle(payload, requirements);
    if (!settled.success) {
      return { ok: false, reason: `Payment settlement failed: ${settled.errorReason ?? "settlement declined"}.` };
    }
    return { ok: true, responseHeader: Buffer.from(JSON.stringify(settled), "utf8").toString("base64") };
  } catch (err) {
    console.error("[x402] facilitator error:", err);
    return { ok: false, reason: "Payment processing error while contacting the OKX facilitator. Please retry." };
  }
}

/**
 * Express middleware guarding story-creation endpoints.
 *
 * Free mode (A2MCP "free endpoint"): always proceeds — HTTP 200 with the
 * result directly. A courtesy quota is enforced with 429 (never 402, which
 * would misrepresent the service as paid).
 *
 * Challenge mode (A2MCP "x402 pay-per-call endpoint"): every call without a
 * payment gets the standard 402 + PAYMENT-REQUIRED challenge; calls carrying
 * X-PAYMENT are verified + settled through the OKX facilitator and proceed
 * with a PAYMENT-RESPONSE header on success.
 */
export function x402Guard(cfg: X402Config, meter: UsageMeter, facilitator: FacilitatorLike | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Payment-Mode", cfg.mode);

    if (cfg.mode === "free") {
      const used = meter.hit(clientKey(req));
      const remaining = Math.max(0, cfg.freeDaily - used);
      res.setHeader("X-Free-Calls-Remaining", String(remaining));
      if (used > cfg.freeDaily) {
        res.status(429).json({
          error: `Free daily quota (${cfg.freeDaily}) exhausted. Retry after 00:00 UTC.`,
        });
        return;
      }
      next();
      return;
    }

    // x402 pay-per-call: no payment header → standard 402 challenge.
    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader !== "string" || paymentHeader.length === 0) {
      send402(res, buildChallenge(cfg, req.path));
      return;
    }

    // Payment provided → verify + settle via the OKX facilitator.
    void settlePayment(cfg, facilitator, paymentHeader, req.path).then((outcome) => {
      if (outcome.ok) {
        res.setHeader("PAYMENT-RESPONSE", outcome.responseHeader);
        next();
        return;
      }
      send402(res, { ...buildChallenge(cfg, req.path), error: outcome.reason });
    });
  };
}

/** Public pricing/info document served at /x402/info. */
export function x402Info(cfg: X402Config, settlementEnabled: boolean): Record<string, unknown> {
  return {
    service: "plotline",
    mode: cfg.mode,
    settlement: settlementEnabled
      ? "enabled — X-PAYMENT payloads are verified and settled via the OKX facilitator (syncSettle)"
      : "disabled — operator has not configured OKX Developer Portal credentials",
    pricing: {
      model: cfg.mode === "free" ? "free (courtesy quota headers attached)" : "freemium",
      freeCallsPerDay: cfg.freeDaily,
      pricePerStoryUsd: cfg.priceUsd,
      currency: "USDT0",
      network: XLAYER_NETWORK,
      networkName: "OKX X Layer",
      asset: USDT0_ADDRESS,
      scheme: "exact",
      payTo: cfg.payTo,
    },
    protocol: {
      name: "x402",
      version: 2,
      challengeHeader: "PAYMENT-REQUIRED (base64 JSON — validated by the marketplace; mirrored in the 402 body)",
      paymentHeader: "X-PAYMENT",
    },
    notes: [
      "Free mode: every call returns HTTP 200 with the result directly (A2MCP-compliant).",
      "Paid mode: every unpaid call returns HTTP 402 with a standard x402 v2 challenge; pay with X-PAYMENT and the call proceeds with a PAYMENT-RESPONSE receipt header.",
    ],
  };
}
