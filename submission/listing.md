# OKX.AI ASP Listing Copy

Use these exact answers when the Onchain OS agent asks for listing details.

## Name
```
Plotline
```

## Tagline (short description)
```
Turn any CSV into a cinematic, scroll-animated data story where every claim — not merely every number — is independently reproducible and cryptographically verifiable.
```

## Description (long)
```
Plotline turns raw CSV data into cinematic scrollytelling web pages that humans actually read — and agents can independently verify.

How it works:
1. FACTS BEFORE PROSE — A deterministic statistics engine computes a ranked "fact ledger" from the raw data: regression trends with 95% confidence intervals and p-values, changepoint detection with Welch significance tests, MAD outliers, Pearson correlations with significance, streaks, seasonality, category leaders, concentration. Every fact carries row-level provenance (the exact source rows behind it).
2. SEMANTIC CLAIM AUDIT — The narrative layer writes a story arc bound scene-by-scene to specific facts. Every number in AI prose must come from the fact its scene is bound to, and direction language is checked against the computed sign ("revenue fell 20%" cannot survive when the data measured +20%). Failing scenes are rewritten deterministically. Hallucinated claims are structurally rejected.
3. SIGNED EVIDENCE — Every story embeds a cryptographic proof bundle: SHA-256 of the dataset, the fact ledger and the story spec, signed with the server's Ed25519 key. Verifiable offline.
4. INDEPENDENT VERIFICATION — The verify_story tool re-runs the ENTIRE analysis from the raw CSV and returns VERIFIED / TAMPERED / UNSUPPORTED_CLAIM / SOURCE_MISMATCH. Reversed trends, swapped numbers, invented percentages, doctored facts and swapped datasets are all caught — so any agent can audit any Plotline story, or catch a forged one. Verification is always free.

Output: one self-contained HTML page (no CDNs, no trackers) with animated charts, a count-up hero stat, confidence badges on every fact, three visual themes and three tones.

MCP tools: create_story, analyze_csv, verify_story, get_story, list_themes, get_pricing.
Free to call (HTTP 200 with result directly); optional paid mode charges per story via x402 (USDT0 on X Layer) through the official OKX facilitator with replay protection.

Use cases: agents presenting sales/metrics/onchain/sensor data to humans without hallucinating; agent-to-agent citation where the receiving agent verifies before trusting; audit trails for AI-generated reports.
```

## Category
```
Data & Analytics (or: Content & Creative)
```

## MCP endpoint URL
```
https://plotline-production-34e6.up.railway.app/mcp
```

## Pricing
```
Free type: HTTP 200 with the result directly; 25 stories/day per client (429 over quota).
Paid type (optional deploy): every unpaid call returns HTTP 402 + PAYMENT-REQUIRED
header with an x402 v2 challenge — $0.20 USDT0 per story on X Layer (eip155:196).
```

## Tool list (if asked)
```
create_story  — CSV (+question/tone/theme) → shareable story URL + metadata + audit report + signed proof
analyze_csv   — CSV → ranked fact ledger (CIs, p-values, provenance) as structured JSON
verify_story  — CSV + story → recompute everything → VERIFIED / TAMPERED / UNSUPPORTED_CLAIM / SOURCE_MISMATCH
get_story     — fetch an existing story's URL/metadata by ID
list_themes   — available visual themes and narrative tones
get_pricing   — live quota and x402 payment details
```

## Support / docs URL
```
https://github.com/Tonyflam/okx_101
```
