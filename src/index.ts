import { createApp, VERSION } from "./app.js";
import { x402ConfigFromEnv } from "./x402.js";

const PORT = Number(process.env.PORT ?? 8484);
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const DATA_DIR = process.env.DATA_DIR ?? "./data";

const x402cfg = x402ConfigFromEnv(BASE_URL);
const app = createApp({ baseUrl: BASE_URL, dataDir: DATA_DIR, x402: x402cfg });

app.listen(PORT, () => {
  console.log(`Plotline v${VERSION} listening on :${PORT}`);
  console.log(`  Landing   ${BASE_URL}/`);
  console.log(`  MCP       ${BASE_URL}/mcp`);
  console.log(`  Health    ${BASE_URL}/api/health`);
  console.log(
    x402cfg.mode === "challenge"
      ? `  Payments  x402 paid mode ($${x402cfg.priceUsd.toFixed(2)}/story, 402 per unpaid call)`
      : `  Payments  free mode (${x402cfg.freeDaily} stories/day per client)`,
  );
  console.log(`  Narration ${process.env.LLM_API_KEY ? "AI + numeric audit" : "deterministic engine"}`);
});
