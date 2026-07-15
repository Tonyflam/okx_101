#!/usr/bin/env node
// ── Plotline: The Gauntlet ──────────────────────────────────────────────────
// Six attacks against a Plotline story. Six correct verdicts. Zero lies survive.
// Built to be screen-recorded: big banners, colors, deliberate pacing.
//
//   node demo/attack-demo.mjs                 (records at cinematic pace)
//   SPEED=0 node demo/attack-demo.mjs         (instant, for testing)
//   node demo/attack-demo.mjs https://my-host (other Plotline instance)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createHash, sign, createPublicKey } from "node:crypto";

const BASE = process.argv[2] ?? "https://plotline-production-34e6.up.railway.app";
const SPEED = process.env.SPEED === undefined ? 1 : Number(process.env.SPEED);
const csv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "demo-data.csv"), "utf8");

// ── tiny cinema toolkit ─────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", amber: "\x1b[38;5;214m",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const out = (s = "") => process.stdout.write(s + "\n");

async function act(n, title, subtitle) {
  await sleep(900);
  out();
  out(`${C.amber}${"─".repeat(64)}${C.reset}`);
  out(`${C.amber}${C.bold}  ACT ${n} · ${title}${C.reset}`);
  out(`${C.dim}  ${subtitle}${C.reset}`);
  out(`${C.amber}${"─".repeat(64)}${C.reset}`);
  await sleep(1400);
}

const VERDICT_STYLE = {
  VERIFIED: { color: C.green, icon: "✅" },
  TAMPERED: { color: C.red, icon: "❌" },
  UNSUPPORTED_CLAIM: { color: C.red, icon: "❌" },
  SOURCE_MISMATCH: { color: C.magenta, icon: "❌" },
  LEGACY_UNVERIFIED: { color: C.yellow, icon: "⚠️ " },
};

async function verify(body, expectDetailFrom) {
  out(`${C.dim}  → POST ${BASE}/api/verify${C.reset}`);
  await sleep(700);
  const report = await (await fetch(`${BASE}/api/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  const { color, icon } = VERDICT_STYLE[report.verdict] ?? { color: C.red, icon: "❌" };
  const label = ` ${icon}  ${report.verdict} `;
  const pad = "─".repeat(Math.max(4, label.length + 3));
  out(`  ${color}┌${pad}┐${C.reset}`);
  out(`  ${color}│ ${C.bold}${label}${C.reset}${color}  │${C.reset}`);
  out(`  ${color}└${pad}┘${C.reset}`);
  const failed = report.checks?.find((c) => !c.ok && (!expectDetailFrom || c.name === expectDetailFrom));
  if (failed) {
    await sleep(500);
    out(`${C.dim}  ${failed.name}: ${C.reset}${failed.detail.split("—")[0].split(":").slice(-1)[0].trim().slice(0, 90)}`);
  }
  await sleep(1600);
  return report.verdict;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// attacker-side canonical JSON + Ed25519 (what a sophisticated forger would do)
const canon = (v) =>
  v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
    : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ── the show ────────────────────────────────────────────────────────────────
const results = [];

out();
out(`${C.bold}${C.amber}  PLOTLINE — THE GAUNTLET${C.reset}`);
out(`${C.dim}  Every story claims to be true. Let's try to make this one lie.${C.reset}`);
await sleep(2000);

out();
out(`${C.cyan}  Creating a story from 14 months of raw startup data…${C.reset}`);
const created = await (await fetch(`${BASE}/api/story`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ csv, dataset_name: "14 months of a startup", question: "How is our growth story holding up?" }),
})).json();
const spec = await (await fetch(`${BASE}/story/${created.storyId ?? created.id}.json`)).json();
await sleep(600);
out(`${C.dim}  story: ${C.reset}${created.url}`);
out(`${C.dim}  facts: ${spec.facts.length} · scenes: ${spec.scenes.length} · proof: Ed25519-signed${C.reset}`);

await act(1, "THE HONEST STORY", "The original story, the original data. Nothing touched.");
results.push(await verify({ csv, storyId: created.storyId ?? created.id }));

await act(2, "THE REVERSED TREND", "Flip the claim's direction field: growth becomes decline. (Proof stripped to dodge the signature — it won't help.)");
{
  const forged = clone(spec);
  delete forged.proof;
  const scene = forged.scenes.find((s) => s.kind === "insight" && s.claim?.direction === "up");
  scene.claim.direction = "down";
  results.push(await verify({ csv, spec: forged }, "claims-supported"));
}

await act(3, "THE PERFECT FORGERY", "Edit the story, recompute EVERY hash, re-sign with the attacker's own Ed25519 key. Internally flawless.");
{
  const forged = clone(spec);
  forged.title = "Growth has never looked better";
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
  const { proof: _p, ...sans } = forged;
  const base = {
    version: 1, engine: spec.proof.engine, algorithm: "ed25519",
    csvSha256: sha(csv), factsSha256: sha(canon(forged.facts)), storySha256: sha(canon(sans)), publicKey,
  };
  base.signature = sign(null, Buffer.from(canon(base)), privateKey).toString("base64");
  forged.proof = base;
  results.push(await verify({ csv, spec: forged }, "proof-signature"));
}

await act(4, "THE WORD SWAP", 'Numbers untouched, claim untouched — only the prose now says "active_users" instead of "revenue".');
{
  const forged = clone(spec);
  delete forged.proof;
  const scene = forged.scenes.find((s) => s.kind === "insight" && s.claim?.metric === "revenue");
  scene.headline = scene.headline.replace(/revenue/gi, "active_users");
  scene.body = scene.body.replace(/revenue/gi, "active_users");
  results.push(await verify({ csv, spec: forged }, "claims-supported"));
}

await act(5, "THE STRIPPED PROOF", "Delete the proof and every structured claim. Maybe it just… passes quietly?");
{
  const forged = clone(spec);
  delete forged.proof;
  for (const s of forged.scenes) if (s.kind === "insight") delete s.claim;
  results.push(await verify({ csv, spec: forged }));
}

await act(6, "THE WRONG DATASET", "The story is authentic — but the CSV offered as evidence has one doctored cell (31500 → 91500).");
results.push(await verify({ csv: csv.replace("31500", "91500"), storyId: created.storyId ?? created.id }));

await sleep(800);
out();
out(`${C.amber}${"═".repeat(64)}${C.reset}`);
out(`${C.bold}  SIX ATTACKS. ${C.green}ONE truth verified${C.reset}${C.bold} — ${C.red}five lies caught${C.reset}${C.bold}. Zero survived.${C.reset}`);
out(`${C.dim}  Anyone can run this: POST /api/verify — always free.${C.reset}`);
out(`${C.amber}${"═".repeat(64)}${C.reset}`);
out();

const expected = ["VERIFIED", "UNSUPPORTED_CLAIM", "TAMPERED", "UNSUPPORTED_CLAIM", "LEGACY_UNVERIFIED", "SOURCE_MISMATCH"];
if (JSON.stringify(results) !== JSON.stringify(expected)) {
  console.error("UNEXPECTED VERDICTS:", results, "expected:", expected);
  process.exit(1);
}
