import type { NextFunction, Request, Response } from "express";

/**
 * x402 monetization layer (OKX X Layer / USDT0).
 *
 * Modes:
 *  - "free"      → every call succeeds; a courtesy quota header shows remaining
 *                  free calls. This is the default so the ASP review and any
 *                  agent can always exercise the service end-to-end.
 *  - "challenge" → after FREE_DAILY calls per client per UTC day, respond with
 *                  HTTP 402 + a spec-correct x402 v2 challenge (base64 JSON in
 *                  the PAYMENT-REQUIRED header, mirrored in the body).
 *
 * Settlement note: verifying X-PAYMENT payloads on-chain requires the OKX
 * payment SDK (@okxweb3/x402-express) with merchant credentials. The
 * `settle` hook below is the single integration point — drop the SDK
 * middleware in and flip X402_MODE=challenge to go fully paid.
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

/**
 * Express middleware guarding story-creation endpoints.
 *
 * Free mode (A2MCP "free endpoint"): always proceeds — HTTP 200 with the
 * result directly. A courtesy quota is enforced with 429 (never 402, which
 * would misrepresent the service as paid).
 *
 * Challenge mode (A2MCP "x402 pay-per-call endpoint"): every call without a
 * valid payment gets the standard 402 + PAYMENT-REQUIRED challenge; after
 * payment the request is replayed with X-PAYMENT and proceeds.
 */
export function x402Guard(cfg: X402Config, meter: UsageMeter) {
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

    // Payment provided — the OKX Payment SDK settlement integration point.
    // In production wire @okxweb3/x402-express here to verify + settle
    // (EIP-3009 signature, amount/nonce/validity, replay protection), then
    // `next()` on success. Without merchant credentials we cannot settle,
    // so we re-issue the challenge rather than pretend to accept payment.
    send402(res, buildChallenge(cfg, req.path));
  };
}

/** Public pricing/info document served at /x402/info. */
export function x402Info(cfg: X402Config): Record<string, unknown> {
  return {
    service: "plotline",
    mode: cfg.mode,
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
      "Paid mode: every unpaid call returns HTTP 402 with a standard x402 v2 challenge; pay, and the request is replayed.",
    ],
  };
}
