import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMcpServer } from "./mcp.js";
import { createStory, UserError } from "./pipeline.js";
import { StoryStore } from "./store.js";
import { isValidStoryId } from "./util.js";
import { UsageMeter, x402ConfigFromEnv, x402Guard, x402Info } from "./x402.js";

const VERSION = "1.0.0";
const PORT = Number(process.env.PORT ?? 8484);
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const ROOT = resolve(import.meta.dirname, "..");

const store = new StoryStore(DATA_DIR);
const x402cfg = x402ConfigFromEnv(BASE_URL);
const meter = new UsageMeter();
const guard = x402Guard(x402cfg, meter);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "3mb" }));
app.use(express.text({ type: "text/csv", limit: "3mb" }));

// ── Landing + static assets ────────────────────────────────────────────────
app.use(express.static(join(ROOT, "public"), { index: "index.html", maxAge: "5m" }));

// ── Sample datasets (whitelisted names only) ───────────────────────────────
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

// ── REST API ───────────────────────────────────────────────────────────────
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
      { baseUrl: BASE_URL, save: (spec, html) => store.save(spec, html) },
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
  res.json(x402Info(x402cfg));
});

app.get("/llms.txt", (_req, res) => {
  res.type("text/plain").send(llmsTxt());
});

// ── MCP endpoint (Streamable HTTP, stateless) ──────────────────────────────
// Only story-creating tool calls consume quota; handshakes stay free.
const mcpGuard = (req: Request, res: Response, next: NextFunction): void => {
  const body = req.body as { method?: string; params?: { name?: string } } | undefined;
  if (body?.method === "tools/call" && body.params?.name === "create_story") {
    guard(req, res, next);
    return;
  }
  next();
};

app.post("/mcp", mcpGuard, async (req, res) => {
  const server = createMcpServer({ baseUrl: BASE_URL, store, x402: x402cfg, version: VERSION });
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
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// ── Fallbacks ──────────────────────────────────────────────────────────────
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

app.listen(PORT, () => {
  console.log(`Plotline listening on :${PORT}`);
  console.log(`  Landing   ${BASE_URL}/`);
  console.log(`  MCP       ${BASE_URL}/mcp`);
  console.log(`  Health    ${BASE_URL}/api/health`);
  console.log(`  Payments  ${x402cfg.mode} mode (${x402cfg.freeDaily} free/day)`);
  console.log(`  Narration ${process.env.LLM_API_KEY ? "AI + numeric audit" : "deterministic engine"}`);
});

function notFoundPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Not found — Plotline</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#07080f;color:#eef0fa;display:grid;place-items:center;min-height:100vh;margin:0}
a{color:#6ea8ff}</style></head>
<body><div style="text-align:center"><h1>404</h1><p>This story doesn't exist (or expired).</p><p><a href="/">Make one at Plotline</a></p></div></body></html>`;
}

function llmsTxt(): string {
  return `# Plotline — the storytelling engine of the agent economy

Turn any CSV into a cinematic, scroll-animated data story with machine-verified numbers.

## What it does
POST raw CSV (+ optional question) → deterministic statistics engine computes a fact
ledger (trends, changepoints, MAD outliers, Pearson correlations, streaks, seasonality,
category leaders, concentration) → narrative written around ONLY those facts, with every
number audited against the ledger → returns a URL to a self-contained scrollytelling page.

## Endpoints
- MCP (Streamable HTTP): POST ${BASE_URL}/mcp
  Tools: create_story, analyze_csv, get_story, list_themes, get_pricing
- REST: POST ${BASE_URL}/api/story  {"csv": "...", "question": "...", "tone": "documentary|boardroom|punchy", "theme": "midnight|paper|neon"}
- Story page: GET ${BASE_URL}/story/{id}   · spec: GET ${BASE_URL}/story/{id}.json
- Health: GET ${BASE_URL}/api/health · Pricing: GET ${BASE_URL}/x402/info

## Pricing
Free daily quota per client (see X-Free-Calls-Remaining header). Pay-per-story via
x402 (USDT0 on OKX X Layer, network eip155:196) when quota is exhausted in paid mode.

## Honesty model
Numbers come from code, words follow the numbers — never the reverse. AI prose passes a
numeric audit against the fact ledger; failing scenes are rewritten deterministically.
Every story page includes its full fact-ledger appendix.
`;
}
