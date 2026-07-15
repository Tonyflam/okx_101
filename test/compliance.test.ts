import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import type { FacilitatorLike, X402Config } from "../src/x402.js";

function cfg(mode: "free" | "challenge"): X402Config {
  return {
    mode,
    payTo: "0x2222222222222222222222222222222222222222",
    priceUsd: 0.2,
    freeDaily: 25,
    baseUrl: "http://unused.example",
  };
}

const servers: Server[] = [];

function listen(mode: "free" | "challenge", facilitator: FacilitatorLike | null = null): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), "plotline-test-"));
  const app = createApp({ baseUrl: "http://unused.example", dataDir, x402: cfg(mode), facilitator });
  return new Promise((resolvePromise) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const port = (server.address() as AddressInfo).port;
      resolvePromise(`http://127.0.0.1:${port}`);
    });
  });
}

after(() => {
  for (const s of servers) s.close();
});

// ── Official A2MCP self-check: free type ───────────────────────────────────
// "curl -i -X POST https://your-domain/your-path → HTTP 200 + result"

test("A2MCP self-check (free): bare POST /mcp returns 200 + result directly", async () => {
  const base = await listen("free");
  const res = await fetch(`${base}/mcp`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string; tools: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.service, "plotline");
  assert.ok(body.tools.includes("create_story"));
});

test("A2MCP self-check (free): probe with unrelated JSON body still returns 200", async () => {
  const base = await listen("free");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(res.status, 200);
});

// ── Official A2MCP self-check: x402 paid type ──────────────────────────────
// "curl -i -X POST → HTTP 402 + PAYMENT-REQUIRED header, body carries x402Version"

test("A2MCP self-check (paid): bare POST /mcp returns 402 + PAYMENT-REQUIRED", async () => {
  const base = await listen("challenge");
  const res = await fetch(`${base}/mcp`, { method: "POST" });
  assert.equal(res.status, 402);

  // Header is what the marketplace validates: base64 of the challenge JSON.
  const header = res.headers.get("payment-required");
  assert.ok(header, "PAYMENT-REQUIRED header must be present");
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts[0].scheme, "exact");
  assert.equal(challenge.accepts[0].network, "eip155:196");
  assert.equal(challenge.accepts[0].asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
  assert.equal(challenge.accepts[0].amount, "200000");
  assert.equal(challenge.accepts[0].maxTimeoutSeconds, 300);
  assert.ok(challenge.resource.url.endsWith("/mcp"));

  // Body mirrors the challenge and carries x402Version.
  const body = (await res.json()) as { x402Version: number };
  assert.equal(body.x402Version, 2);
});

test("A2MCP (paid): JSON-RPC call without payment also gets the 402 challenge", async () => {
  const base = await listen("challenge");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get("payment-required"));
});

// ── Real MCP traffic still works in free mode ──────────────────────────────

test("MCP initialize works without an Accept header (never 406)", async () => {
  const base = await listen("free");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(body.result.serverInfo.name, "plotline");
});

test("MCP tools/list and tools/call create_story work end-to-end", async () => {
  const base = await listen("free");
  const list = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(list.status, 200);
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.deepEqual(
    tools.sort(),
    ["analyze_csv", "create_story", "get_pricing", "get_story", "list_themes", "verify_story"],
  );

  const csv = "month,revenue\n2024-01,100\n2024-02,130\n2024-03,170\n2024-04,220\n2024-05,290";
  const call = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "create_story", arguments: { csv } },
    }),
  });
  assert.equal(call.status, 200);
  const result = ((await call.json()) as {
    result: { isError?: boolean; structuredContent: { url: string; factCount: number } };
  }).result;
  assert.ok(!result.isError);
  assert.ok(result.structuredContent.url.includes("/story/"));
  assert.ok(result.structuredContent.factCount >= 2);
});

test("GET /mcp returns 405 with JSON-RPC error", async () => {
  const base = await listen("free");
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 405);
});

// ── REST guard behavior per mode ───────────────────────────────────────────

test("free mode REST: 200 with quota header, never 402", async () => {
  const base = await listen("free");
  const res = await fetch(`${base}/api/story`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv: "a,b\n1,2\n2,4\n3,6\n4,8\n5,10" }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-free-calls-remaining"));
  assert.equal(res.headers.get("x-payment-mode"), "free");
});

test("paid mode REST: unpaid POST /api/story gets 402 + PAYMENT-REQUIRED", async () => {
  const base = await listen("challenge");
  const res = await fetch(`${base}/api/story`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv: "a,b\n1,2\n2,4\n3,6" }),
  });
  assert.equal(res.status, 402);
  const header = res.headers.get("payment-required");
  assert.ok(header);
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(challenge.x402Version, 2);
});

// ── x402 settlement via the OKX facilitator ───────────────────────────────

/** Unique per call — the replay cache correctly dedupes identical payloads. */
function paymentHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: "eip155:196",
      payload: { signature: `0xsig-${Math.random().toString(36).slice(2)}` },
    }),
    "utf8",
  ).toString("base64");
}

function fakeFacilitator(overrides: Partial<FacilitatorLike> = {}): FacilitatorLike {
  return {
    verify: async () => ({ isValid: true, payer: "0xpayer" }),
    settle: async () => ({ success: true, transaction: "0xtx", network: "eip155:196", payer: "0xpayer" }),
    ...overrides,
  };
}

test("paid + valid payment: MCP call settles and proceeds with PAYMENT-RESPONSE", async () => {
  const base = await listen("challenge", fakeFacilitator());
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 200);
  const receipt = res.headers.get("payment-response");
  assert.ok(receipt);
  const settled = JSON.parse(Buffer.from(receipt, "base64").toString("utf8"));
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "0xtx");
});

test("paid + rejected payment: 402 challenge with the verification reason", async () => {
  const base = await listen(
    "challenge",
    fakeFacilitator({ verify: async () => ({ isValid: false, invalidReason: "insufficient_funds" }) }),
  );
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error?.includes("insufficient_funds"));
});

test("paid + failed settlement: 402 challenge, never a silent success", async () => {
  const base = await listen(
    "challenge",
    fakeFacilitator({ settle: async () => ({ success: false, errorReason: "settle_timeout" }) }),
  );
  const res = await fetch(`${base}/api/story`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
    body: JSON.stringify({ csv: "a,b\n1,2\n2,4\n3,6" }),
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error?.includes("settle_timeout"));
});

test("paid + malformed X-PAYMENT: 402 with explicit error", async () => {
  const base = await listen("challenge", fakeFacilitator());
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": "not-base64-json!!!" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error?.includes("Malformed X-PAYMENT"));
});

test("paid + payment but no credentials configured: honest 402, not fake success", async () => {
  const base = await listen("challenge", null);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error?.includes("OKX Developer Portal"));
});

test("paid + valid payment REST: story is created and receipt attached", async () => {
  const base = await listen("challenge", fakeFacilitator());
  const res = await fetch(`${base}/api/story`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
    body: JSON.stringify({ csv: "month,revenue\n2024-01,100\n2024-02,130\n2024-03,170\n2024-04,220\n2024-05,290" }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("payment-response"));
  const body = (await res.json()) as { url: string };
  assert.ok(body.url.includes("/story/"));
});

test("replay protection: the same X-PAYMENT settles exactly once", async () => {
  let settleCalls = 0;
  const base = await listen(
    "challenge",
    fakeFacilitator({
      settle: async () => {
        settleCalls++;
        return { success: true, transaction: "0xtx-replay", network: "eip155:196", payer: "0xpayer" };
      },
    }),
  );
  const pay = paymentHeader();
  const call = () =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": pay },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const [a, b] = await Promise.all([call(), call()]);
  const c = await call();
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 200);
  assert.equal(settleCalls, 1, "duplicate X-PAYMENT must not settle twice");
});
