# Plotline

**The storytelling engine of the agent economy.**

Turn any CSV into a cinematic, scroll-animated data story — with every number machine-verified.

```
POST a CSV  →  deterministic stats engine computes a fact ledger
            →  narrative written around ONLY those facts (numeric-audited)
            →  a self-contained scrollytelling page you can share anywhere
```

Built for the **OKX.AI Genesis Hackathon** as an Agentic Service Provider (ASP): MCP-native, x402-payable (USDT0 on OKX X Layer), zero signup.

---

## Why this exists

Agents are getting very good at *fetching* data and very confident at *misquoting* it. When an agent presents analysis to a human — or cites another agent — the numbers must be right. LLMs hallucinate statistics; that's not a prompt problem, it's an architecture problem.

**Plotline inverts the pipeline:**

1. **Facts before prose.** A deterministic TypeScript statistics engine runs first: OLS regression trends, binary-segmentation changepoint detection, MAD outliers, Pearson correlations, streaks, seasonality, category leaders, concentration. Output: a ranked, immutable **fact ledger**.
2. **The numeric audit.** The narrative layer (LLM, optional) writes a story arc around those facts — then *every number* in its prose is extracted and checked against the ledger (0.05 absolute / 1.5 % relative tolerance). Any scene that fails is rewritten by the deterministic narrator. If no LLM key is configured, the deterministic narrator writes the whole story.
3. **Show your work.** Every story page ends with its fact ledger appendix: each claim, its computed value, and the method used.

> Numbers come from code. Words follow the numbers. Never the reverse.

## What you get

A single shareable URL to a **fully self-contained HTML page** (no CDNs, no fonts, no trackers, no external requests):

- Hero scene with an animated count-up stat
- Scroll-triggered scenes: charts that draw themselves (line + trend, bar, scatter + fit, donut), alternating layout
- Three themes — `midnight` (cinematic), `paper` (editorial serif), `neon` (terminal) — and three tones — `documentary`, `boardroom`, `punchy`
- The fact-ledger appendix and an audit line in the footer
- Machine-readable spec at `/story/{id}.json`

## Quickstart

```bash
npm install
npm run dev          # http://localhost:8484
```

Open the landing page, click a sample, hit **Generate story**. Done.

Optional env (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8484` | HTTP port |
| `PUBLIC_BASE_URL` | `http://localhost:8484` | Used in returned story URLs |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | *(unset)* | Optional AI narration (OpenAI-compatible `/chat/completions`). Without it, the deterministic narrator runs — the service never depends on an upstream LLM. |
| `X402_MODE` | `free` | `free` or `challenge` (emit HTTP 402 after quota) |
| `X402_PAY_TO` | zero address | Your X Layer receiving address |
| `X402_PRICE_USD` | `0.20` | Price per story (USDT0) |
| `FREE_DAILY` | `25` | Free stories per client per UTC day |
| `DATA_DIR` | `./data` | Story storage (JSON + HTML files) |

```bash
npm test             # 30 tests: csv, stats, narrative audit, pipeline, XSS
npm run typecheck    # strict TS, noUncheckedIndexedAccess
npm run build && npm start
```

## For agents (MCP)

Streamable HTTP endpoint at **`POST /mcp`** — stateless, no session required.

```json
{
  "mcpServers": {
    "plotline": { "url": "https://YOUR-DEPLOYMENT/mcp" }
  }
}
```

| Tool | What it does |
|---|---|
| `create_story` | CSV (+ optional `question`, `tone`, `theme`, `dataset_name`) → story URL + metadata + audit report |
| `analyze_csv` | CSV → ranked fact ledger as structured JSON (no page rendered) |
| `get_story` | Look up an existing story by ID |
| `list_themes` | Visual themes and narrative tones |
| `get_pricing` | Live quota + x402 payment details |

All tools return both human-readable markdown and `structuredContent` validated by output schemas.

## REST API

```bash
curl -X POST https://YOUR-DEPLOYMENT/api/story \
  -H 'Content-Type: application/json' \
  -d '{"csv":"month,revenue\n2024-01,100\n2024-02,140\n2024-03,190", "question":"Is revenue accelerating?"}'
```

| Route | Method | Description |
|---|---|---|
| `/api/story` | POST | Create a story. Body: `{csv, question?, tone?, theme?, datasetName?}` |
| `/story/{id}` | GET | The story page (HTML) |
| `/story/{id}.json` | GET | The full StorySpec (facts, scenes, audit) |
| `/api/health` | GET | Health + story count + payment mode |
| `/x402/info` | GET | Machine-readable pricing |
| `/llms.txt` | GET | Agent-discovery description |
| `/samples/{name}` | GET | Demo datasets |
| `/mcp` | POST | MCP Streamable HTTP endpoint |

## Payments (x402 on OKX X Layer)

- **Free tier:** `FREE_DAILY` stories per client per UTC day. Every response carries `X-Free-Calls-Remaining`.
- **A2MCP compliance:** free endpoints return **HTTP 200 with the result directly** — exactly what the OKX.AI review expects.
- **Paid mode (`X402_MODE=challenge`):** once quota is exhausted, the server responds `402` with a spec-correct **x402 v2 challenge** — base64 JSON in the `PAYMENT-REQUIRED` header (mirrored in the body): scheme `exact`, network `eip155:196` (X Layer), asset USDT0 (`0x779d…3736`, 6 decimals), `payTo` = your address.
- **Settlement integration point:** `src/x402.ts` marks exactly where `@okxweb3/x402-express` verification/settlement drops in with merchant credentials. Until then, the server declines unverifiable payments honestly rather than pretending to settle.

## Architecture

```
src/
  csv.ts        tolerant CSV parser: delimiter sniffing, quotes, BOM,
                currency/percent numbers, 10+ date formats, type inference
  stats.ts      pure math: describe, OLS regression, Pearson, MAD outliers,
                binary-segmentation changepoint, streaks
  insights.ts   fact extraction + importance ranking + chart spec builders
  narrative.ts  deterministic narrator + optional LLM narrator + numeric audit
  renderer-charts.ts  server-side SVG: line/bar/scatter/donut, animation-ready
  renderer.ts   self-contained scrollytelling HTML (3 themes, IO-based reveal,
                count-up stats, progress bar, fact-ledger appendix)
  pipeline.ts   csv → facts → narrative → page, input limits, safe errors
  store.ts      JSON+HTML file store with LRU cache
  x402.ts       quota meter + x402 v2 challenge emission
  mcp.ts        MCP server: 5 tools with input/output schemas
  index.ts      Express wiring: REST, MCP (stateless streamable HTTP), static
```

Design choices worth noting:

- **Reliability under review:** no database, no build step for pages, LLM optional with deterministic fallback — the demo can never fail because an upstream is down.
- **Security:** every user- or LLM-derived string is HTML-escaped; story IDs are validated; CSV capped at 2 MB / 20k rows; no external resources in rendered pages (CSP-friendly); payment challenges never execute user input.
- **Honesty as a feature:** the audit isn't marketing — `test/narrative.test.ts` proves fabricated numbers get rejected and rewritten.

## Deploy

Any Node 20+ host works. Docker:

```bash
docker build -t plotline .
docker run -p 8484:8484 -e PUBLIC_BASE_URL=https://your.domain plotline
```

Set `PUBLIC_BASE_URL` to your HTTPS domain so returned story URLs are correct.

## License

MIT
