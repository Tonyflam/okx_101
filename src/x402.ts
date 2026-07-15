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

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export function buildRequirements(cfg: X402Config, resourcePath: string): PaymentRequirements {
  const atomic = Math.round(cfg.priceUsd * 1e6); // USDT0 has 6 decimals
  return {
    scheme: "exact",
    network: XLAYER_NETWORK,
    maxAmountRequired: String(atomic),
    resource: `${cfg.baseUrl}${resourcePath}`,
    description: "Plotline: turn a CSV into a verified, cinematic data story.",
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: 120,
    asset: USDT0_ADDRESS,
    extra: { name: "USDT0", version: "1" },
  };
}

/**
 * Express middleware guarding story-creation endpoints.
 * Always attaches quota headers; only blocks in challenge mode.
 */
export function x402Guard(cfg: X402Config, meter: UsageMeter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientKey(req);
    const used = meter.hit(key);
    const remaining = Math.max(0, cfg.freeDaily - used);
    res.setHeader("X-Free-Calls-Remaining", String(remaining));
    res.setHeader("X-Payment-Mode", cfg.mode);

    if (cfg.mode === "free" || used <= cfg.freeDaily) {
      next();
      return;
    }

    // Payment provided? This is the OKX SDK settlement integration point.
    const paymentHeader = req.headers["x-payment"];
    if (typeof paymentHeader === "string" && paymentHeader.length > 0) {
      // In production wire @okxweb3/x402-express here to verify + settle,
      // then `next()` on success. Without merchant credentials we cannot
      // settle, so we decline explicitly rather than pretend.
      res.status(402).json({
        x402Version: 2,
        error: "Payment verification unavailable in this deployment; settlement requires the operator's OKX payment credentials.",
        accepts: [buildRequirements(cfg, req.path)],
      });
      return;
    }

    const requirements = buildRequirements(cfg, req.path);
    const challenge = {
      x402Version: 2,
      error: `Free daily quota (${cfg.freeDaily}) exhausted. Pay ${cfg.priceUsd} USDT0 on X Layer per story, or retry after 00:00 UTC.`,
      accepts: [requirements],
    };
    res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"));
    res.status(402).json(challenge);
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
      challengeHeader: "PAYMENT-REQUIRED (base64 JSON, mirrored in the 402 response body)",
      paymentHeader: "X-PAYMENT",
    },
    notes: [
      "Free endpoints return HTTP 200 with the result directly (A2MCP-compliant).",
      "In challenge mode, the first FREE_DAILY calls per client per UTC day are free.",
    ],
  };
}
