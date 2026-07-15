# OKX.AI ASP Listing Copy

Use these exact answers when the Onchain OS agent asks for listing details.

## Name
```
Plotline
```

## Tagline (short description)
```
The storytelling engine of the agent economy — turn any CSV into a cinematic, scroll-animated data story with every number machine-verified.
```

## Description (long)
```
Plotline turns raw CSV data into cinematic scrollytelling web pages that humans actually read — and agents can actually trust.

How it works:
1. FACTS BEFORE PROSE — A deterministic statistics engine computes a ranked "fact ledger" from the raw data: regression trends, changepoint detection, MAD outliers, Pearson correlations, streaks, seasonality, category leaders, concentration.
2. THE NUMERIC AUDIT — The narrative layer writes a story arc around only those facts. Every number in AI-written prose is audited against the ledger; failing scenes are rewritten deterministically. Hallucinated statistics are structurally impossible.
3. SHOW YOUR WORK — Every story page ships with its full fact-ledger appendix (claim, value, method), an audit line, and a machine-readable JSON spec.

Output: one self-contained HTML page (no CDNs, no trackers) with animated charts that draw themselves, a count-up hero stat, three visual themes (midnight/paper/neon) and three tones (documentary/boardroom/punchy).

MCP tools: create_story, analyze_csv, get_story, list_themes, get_pricing.
Free to call (HTTP 200 with result directly); optional paid mode charges per story via x402 (USDT0 on X Layer).

Use cases: agents turning sales/metrics/onchain/sensor/personal data into shareable reports, weekly business reviews, community updates, research summaries — anywhere an agent must present numbers to a human without hallucinating them.
```

## Category
```
Data & Analytics (or: Content & Creative)
```

## MCP endpoint URL
```
https://<YOUR-DEPLOYMENT>/mcp
```

## Pricing
```
Free type: HTTP 200 with the result directly; 25 stories/day per client (429 over quota).
Paid type (optional deploy): every unpaid call returns HTTP 402 + PAYMENT-REQUIRED
header with an x402 v2 challenge — $0.20 USDT0 per story on X Layer (eip155:196).
```

## Tool list (if asked)
```
create_story  — CSV (+question/tone/theme) → shareable story URL + metadata + numeric-audit report
analyze_csv   — CSV → ranked fact ledger as structured JSON
get_story     — fetch an existing story's URL/metadata by ID
list_themes   — available visual themes and narrative tones
get_pricing   — live quota and x402 payment details
```

## Support / docs URL
```
https://github.com/Tonyflam/okx_101
```
