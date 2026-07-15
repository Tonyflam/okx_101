import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChallenge, x402ConfigFromEnv, type X402Config } from "../src/x402.js";

function cfg(mode: "free" | "challenge" = "challenge"): X402Config {
  return {
    mode,
    payTo: "0x1111111111111111111111111111111111111111",
    priceUsd: 0.2,
    freeDaily: 25,
    baseUrl: "https://plotline.example",
  };
}

test("challenge matches the official A2MCP v2 structure exactly", () => {
  const c = buildChallenge(cfg(), "/mcp");
  // Top-level shape per the OKX A2MCP guide
  assert.equal(c.x402Version, 2);
  assert.deepEqual(Object.keys(c).sort(), ["accepts", "resource", "x402Version"]);
  assert.equal(c.resource.url, "https://plotline.example/mcp");
  assert.equal(c.resource.mimeType, "application/json");
  assert.ok(c.resource.description.length > 0);

  const a = c.accepts[0]!;
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:196"); // CAIP-2, X Layer
  assert.equal(a.asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736"); // USDT0
  assert.equal(a.amount, "200000"); // 0.20 USD in minimal units (decimals=6)
  assert.equal(a.payTo, "0x1111111111111111111111111111111111111111");
  assert.equal(a.maxTimeoutSeconds, 300);
  assert.deepEqual(a.extra, { name: "USD₮0", version: "1" });
});

test("challenge amount uses minimal units with 6 decimals", () => {
  const c = { ...cfg(), priceUsd: 0.01 };
  assert.equal(buildChallenge(c, "/mcp").accepts[0]!.amount, "10000"); // doc example: 10000 = 0.01
  const c2 = { ...cfg(), priceUsd: 1 };
  assert.equal(buildChallenge(c2, "/mcp").accepts[0]!.amount, "1000000");
});

test("challenge header payload is valid base64 JSON", () => {
  const c = buildChallenge(cfg(), "/mcp");
  const b64 = Buffer.from(JSON.stringify(c), "utf8").toString("base64");
  const roundTrip = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(c)));
});

test("x402ConfigFromEnv defaults to free mode with sane price", () => {
  delete process.env.X402_MODE;
  delete process.env.X402_PRICE_USD;
  const c = x402ConfigFromEnv("https://x.example");
  assert.equal(c.mode, "free");
  assert.equal(c.priceUsd, 0.2);
  assert.ok(c.freeDaily >= 1);
});
