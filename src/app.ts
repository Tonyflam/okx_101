import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMcpServer } from "./mcp.js";
import { createStory, UserError } from "./pipeline.js";
import { loadSigner, trustedKeysFromEnv, type ProofSigner } from "./proof.js";
import { StoryStore } from "./store.js";
import { isValidStoryId } from "./util.js";
import { verifyStory } from "./verify.js";
import type { StorySpec } from "./types.js";
import {
  UsageMeter,
  x402Guard,
  x402Info,
  buildChallenge,
  send402,
  settlePayment,
  facilitatorFromEnv,
  type FacilitatorLike,
  type X402Config,
} from "./x402.js";

export const VERSION = "1.1.0";
const ROOT = resolve(import.meta.dirname, "..");

export interface AppOptions {
  baseUrl: string;
  dataDir: string;
  x402: X402Config;
  /** Payment facilitator; defaults to env-configured OKX client (or null). Injectable for tests. */
  facilitator?: FacilitatorLike | null;
}

/** Build the fully-wired Express app (no listener) — testable in isolation. */
export function createApp(opts: AppOptions): Express {
  const { baseUrl: BASE_URL, x402: x402cfg } = opts;
  const facilitator = opts.facilitator !== undefined ? opts.facilitator : facilitatorFromEnv();
  const store = new StoryStore(opts.dataDir);
  const meter = new UsageMeter();
  const guard = x402Guard(x402cfg, meter, facilitator);
  const signer: ProofSigner = loadSigner(opts.dataDir);
  const trustedKeys = trustedKeysFromEnv(signer.publicKey);
  const ENGINE = `plotline@${VERSION}`;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "3mb" }));
  app.use(express.text({ type: "text/csv", limit: "3mb" }));

  // ── Landing + static assets ──────────────────────────────────────────────
  app.use(express.static(join(ROOT, "public"), { index: "index.html", maxAge: "5m" }));

  // ── Sample datasets (whitelisted names only) ─────────────────────────────
  app.get("/samples/:name", (req, res) => {
    const name = req.params.name;
    if (!/^[a-z0-9-]{1,60}\.csv$/.test(name)) {
      res.status(404).json({ error: "sample not found" });
      return;
    }
    const path = join(ROOT, "samples", name);
    if (!existsSync(path)) {
      res.status(404).json({ error: "sample not found" });
      return;
    }
    res.type("text/csv").sendFile(path);
  });

  // ── REST API ─────────────────────────────────────────────────────────────
  app.post("/api/story", guard, async (req, res, next) => {
    try {
      const body = typeof req.body === "string" ? { csv: req.body } : (req.body ?? {});
      const result = await createStory(
        {
          csv: String(body.csv ?? ""),
          question: body.question,
          tone: body.tone,
          theme: body.theme,
          datasetName: body.datasetName ?? body.dataset_name,
        },
        { baseUrl: BASE_URL, save: (spec, html) => store.save(spec, html), signer, engine: ENGINE },
      );
      res.status(200).json({
        storyId: result.spec.id,
        url: result.url,
        specUrl: `${result.url}.json`,
        title: result.spec.title,
        subtitle: result.spec.subtitle,
        sceneCount: result.spec.scenes.length,
        factCount: result.spec.facts.length,
        narrativeMode: result.spec.narrativeMode,
        numericAudit: result.spec.numericAudit ?? null,
        theme: result.spec.theme,
        tone: result.spec.tone,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/story/:id.json", (req, res) => {
    const id = req.params.id;
    const spec = isValidStoryId(id) ? store.getSpec(id) : null;
    if (!spec) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    res.json(spec);
  });

  // ── Independent verification: recompute everything, audit every claim ───
  app.post("/api/verify", (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { csv?: unknown; storyId?: unknown; spec?: unknown };
      const csv = String(body.csv ?? "");
      if (!csv.trim()) throw new UserError("`csv` is required — the original dataset to verify against.");
      let spec: StorySpec | null = null;
      if (typeof body.storyId === "string" && body.storyId) {
        spec = isValidStoryId(body.storyId) ? store.getSpec(body.storyId) : null;
        if (!spec) throw new UserError(`No story found with id \`${body.storyId}\`.`);
      } else if (body.spec && typeof body.spec === "object") {
        spec = body.spec as StorySpec;
        if (!Array.isArray(spec.facts) || !Array.isArray(spec.scenes)) {
          throw new UserError("`spec` does not look like a Plotline StorySpec (needs facts[] and scenes[]).");
        }
      } else {
        throw new UserError("Provide `storyId` or a full `spec` object alongside `csv`.");
      }
      res.json(verifyStory(csv, spec, ENGINE, trustedKeys));
    } catch (err) {
      next(err);
    }
  });

  // Public verification key — pin this to verify proof bundles offline.
  app.get("/api/proof-key", (_req, res) => {
    res.json({ algorithm: "ed25519", format: "spki-der-base64", publicKey: signer.publicKey, engine: ENGINE });
  });

  app.get("/story/:id", (req, res) => {
    const id = req.params.id;
    const html = isValidStoryId(id) ? store.getHtml(id) : null;
    if (!html) {
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    res.type("html").send(html);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "plotline",
      version: VERSION,
      stories: store.count(),
      paymentMode: x402cfg.mode,
      llm: process.env.LLM_API_KEY ? "configured" : "deterministic-fallback",
      time: new Date().toISOString(),
    });
  });

  app.get("/x402/info", (_req, res) => {
    res.json(x402Info(x402cfg, facilitator !== null));
  });

  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").send(llmsTxt(BASE_URL));
  });

  // ── MCP endpoint (Streamable HTTP, stateless) ────────────────────────────
  // A2MCP compliance layer, per the official self-check (`curl -i -X POST /mcp`):
  //   Free type  → HTTP 200 + result directly (never 406/400 on a bare probe)
  //   Paid type  → HTTP 402 + PAYMENT-REQUIRED challenge on every unpaid call;
  //                X-PAYMENT payloads are verified + settled via the OKX
  //                facilitator before the call proceeds.
  const mcpCompliance = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Payment-Mode", x402cfg.mode);

    // Paid mode: unpaid calls get the standard 402 challenge; paid calls are
    // verified and settled before any MCP processing happens.
    if (x402cfg.mode === "challenge") {
      const pay = req.headers["x-payment"];
      if (typeof pay !== "string" || pay.length === 0) {
        send402(res, buildChallenge(x402cfg, "/mcp"));
        return;
      }
      void settlePayment(x402cfg, facilitator, pay, "/mcp").then((outcome) => {
        if (!outcome.ok) {
          send402(res, { ...buildChallenge(x402cfg, "/mcp"), error: outcome.reason });
          return;
        }
        res.setHeader("PAYMENT-RESPONSE", outcome.responseHeader);
        proceed(req, res, next);
      });
      return;
    }

    proceed(req, res, next);
  };

  // Everything after the payment gate: probe card, Accept normalization, quota.
  const serviceCard = () => ({
    ok: true,
    service: "plotline",
    description:
      "Turn any CSV into a cinematic, scroll-animated data story where every claim is independently reproducible and cryptographically verifiable.",
    type: "A2MCP",
    transport: "MCP Streamable HTTP (JSON-RPC 2.0 over POST)",
    tools: ["create_story", "analyze_csv", "verify_story", "get_story", "list_themes", "get_pricing"],
    usage: "POST JSON-RPC to this endpoint: initialize → tools/list → tools/call",
    example: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    landing: BASE_URL,
    docs: `${BASE_URL}/llms.txt`,
    pricing: `${BASE_URL}/x402/info`,
    health: `${BASE_URL}/api/health`,
    proofKey: `${BASE_URL}/api/proof-key`,
  });

  const proceed = (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as unknown;
    const isBatch = Array.isArray(body) && body.length > 0;
    const isJsonRpc =
      isBatch ||
      (typeof body === "object" && body !== null && typeof (body as { method?: unknown }).method === "string");

    // Bare probe / non-JSON-RPC POST: return the result directly (HTTP 200).
    if (!isJsonRpc) {
      res.status(200).json(serviceCard());
      return;
    }

    // Real MCP traffic: normalize the Accept header so strict SDK content
    // negotiation never rejects a legitimate caller (we always answer JSON).
    // The SDK's Node transport rebuilds the web Request from req.rawHeaders,
    // so both representations must be patched.
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      const normalized = "application/json, text/event-stream";
      req.headers.accept = normalized;
      const raw = req.rawHeaders;
      let patched = false;
      for (let i = 0; i < raw.length; i += 2) {
        if (String(raw[i]).toLowerCase() === "accept") {
          raw[i + 1] = normalized;
          patched = true;
        }
      }
      if (!patched) raw.push("Accept", normalized);
    }

    // Free mode: only story-creating calls consume quota; handshakes stay free.
    const rpc = body as { method?: string; params?: { name?: string } };
    if (!isBatch && rpc.method === "tools/call" && rpc.params?.name === "create_story" && x402cfg.mode === "free") {
      guard(req, res, next);
      return;
    }
    next();
  };

  app.post("/mcp", mcpCompliance, async (req, res) => {
    const server = createMcpServer({ baseUrl: BASE_URL, store, x402: x402cfg, version: VERSION, signer });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] transport error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. POST JSON-RPC to /mcp." },
      id: null,
    });
  };
  // Marketplace validators (e.g. the task flow's x402 endpoint check) probe
  // /mcp with GET: answer exactly like a bare POST probe — the 402 challenge
  // in paid mode, the service card in free mode. Never 405. (Express serves
  // HEAD through this GET route automatically.)
  app.get("/mcp", (_req, res) => {
    res.setHeader("X-Payment-Mode", x402cfg.mode);
    if (x402cfg.mode === "challenge") {
      send402(res, buildChallenge(x402cfg, "/mcp"));
      return;
    }
    res.status(200).json(serviceCard());
  });
  app.delete("/mcp", methodNotAllowed);

  // ── Fallbacks ────────────────────────────────────────────────────────────
  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path === "/mcp") {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(404).type("html").send(notFoundPage());
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UserError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError && "body" in (err as object)) {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }
    console.error("[plotline] error:", err);
    res.status(500).json({ error: "Internal error. Please retry." });
  });

  return app;
}

function notFoundPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Not found — Plotline</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#07080f;color:#eef0fa;display:grid;place-items:center;min-height:100vh;margin:0}
a{color:#6ea8ff}</style></head>
<body><div style="text-align:center"><h1>404</h1><p>This story doesn't exist (or expired).</p><p><a href="/">Make one at Plotline</a></p></div></body></html>`;
}

function llmsTxt(BASE_URL: string): string {
  return `# Plotline — verifiable data stories for the agent economy

Turn any CSV into a cinematic, scroll-animated data story where every claim — not
merely every number — is independently reproducible and cryptographically verifiable.

## What it does
POST raw CSV (+ optional question) → deterministic statistics engine computes a fact
ledger (trends with 95% confidence intervals, changepoints with Welch significance
tests, MAD outliers, Pearson correlations with p-values, streaks, seasonality,
category leaders, concentration) with row-level provenance → narrative written around
ONLY those facts; every number AND direction in AI prose is audited against the
specific fact each scene is bound to → story ships with a signed proof bundle
(SHA-256 of dataset/ledger/spec + Ed25519 signature, verifiable offline).

## Endpoints
- MCP (Streamable HTTP): POST ${BASE_URL}/mcp
  Tools: create_story, analyze_csv, verify_story, get_story, list_themes, get_pricing
- REST: POST ${BASE_URL}/api/story  {"csv": "...", "question": "...", "tone": "documentary|boardroom|punchy", "theme": "midnight|paper|neon"}
- Verify: POST ${BASE_URL}/api/verify  {"csv": "...", "storyId": "..."} → VERIFIED | TAMPERED | UNSUPPORTED_CLAIM | SOURCE_MISMATCH | LEGACY_UNVERIFIED
- Story page: GET ${BASE_URL}/story/{id}   · spec: GET ${BASE_URL}/story/{id}.json
- Proof key: GET ${BASE_URL}/api/proof-key · Health: GET ${BASE_URL}/api/health · Pricing: GET ${BASE_URL}/x402/info

## Pricing
Free daily quota per client (see X-Free-Calls-Remaining header). Pay-per-story via
x402 (USDT0 on OKX X Layer, network eip155:196) when quota is exhausted in paid mode.

## Trust model
Numbers come from code, words follow the numbers — never the reverse. Scene claims
are bound to specific facts (numbers + direction). verify_story re-runs the entire
analysis from the raw CSV so any agent can audit any story — or catch a forged one.
`;
}
