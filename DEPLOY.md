# Deploy + Submission Runbook (deadline: Jul 17, 2026 23:59 UTC)

Work through this top-to-bottom. Listing review takes **up to 24h**, so finish
steps 1–3 **by Jul 16**.

## 1. Deploy publicly (HTTPS)

Fastest path — Render (free tier, Docker):

1. Push this repo to GitHub (already done if you're reading this there).
2. https://dashboard.render.com → New → Web Service → connect `Tonyflam/okx_101`.
   Render auto-detects the `Dockerfile` (or uses `render.yaml`).
3. After the first deploy, copy the public URL (e.g. `https://plotline-xyz.onrender.com`)
   and set env var `PUBLIC_BASE_URL` to exactly that. Redeploy.
4. Verify:
   - `GET  https://<url>/api/health` → `{"ok":true,...}`
   - `GET  https://<url>/` → landing page loads, sample → story works
   - `POST https://<url>/mcp` initialize (see below) → serverInfo `plotline`

```bash
curl -s -X POST https://<url>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
```

Alternatives: Fly.io (`fly launch`), Railway, any VPS with Docker.
Keep `X402_MODE=free` for the review window — free A2MCP endpoints must return
HTTP 200 with the result directly, which is exactly what Plotline does.

## 2. Register + list the ASP on OKX.AI

In any agent with OKX Onchain OS skills installed:

```
npx skills add okx/onchainos-skills --yes -g
```

Then, in the agent chat, run these prompts **in order**:

1. `Log in to Agentic Wallet`
2. `Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS`
3. `Help me list my ASP on OKX.AI using Onchain OS`

When asked for details, use the copy in [submission/listing.md](submission/listing.md)
and your deployed MCP URL: `https://<url>/mcp`.

Review takes up to 24h. If rejected, fix and resubmit immediately.

## 3. X (Twitter) post with #OKXAI

Post the text in [submission/x-post.md](submission/x-post.md) with the ≤90s
demo video (storyboard included in the same file). Must include **#OKXAI**.

## 4. Google form

Submit before **Jul 17, 23:59 UTC** using [submission/form-answers.md](submission/form-answers.md).
Include: repo URL, deployed URL, MCP endpoint, X post URL, listing name.

## Local smoke test (before deploying)

```bash
npm install && npm test && npm run build
PUBLIC_BASE_URL=http://localhost:8484 node dist/index.js
# then: open http://localhost:8484, generate a story from each sample
```

## Optional: enable AI narration

Set `LLM_API_KEY`, `LLM_BASE_URL` (OpenAI-compatible), `LLM_MODEL`.
Stories then use AI prose with the numeric audit; footer shows the audit score.
Without keys the deterministic narrator runs — demo never breaks.

## Optional: enable paid mode

Set `X402_MODE=challenge`, `X402_PAY_TO=<your X Layer address>`,
`X402_PRICE_USD=0.20`. After `FREE_DAILY` calls/day per client, the server
emits spec-correct x402 v2 challenges (402 + `PAYMENT-REQUIRED` header).
Real settlement: integrate `@okxweb3/x402-express` at the marked point in
`src/x402.ts` with your merchant credentials.
