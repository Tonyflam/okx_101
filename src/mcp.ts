import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeCsv, createStory, UserError } from "./pipeline.js";
import { trustedKeysFromEnv, type ProofSigner } from "./proof.js";
import type { StoryStore } from "./store.js";
import { verifyStory } from "./verify.js";
import type { StorySpec } from "./types.js";
import type { X402Config } from "./x402.js";

export interface McpDeps {
  baseUrl: string;
  store: StoryStore;
  x402: X402Config;
  version: string;
  signer?: ProofSigner;
}

const INSTRUCTIONS = `Plotline turns any CSV into a cinematic, scroll-animated data story where every
claim — not merely every number — is independently reproducible and cryptographically
verifiable.

Trust model (why agents can rely on the output):
1. A deterministic statistics engine (regression with confidence intervals, MAD
   outliers, changepoint detection with Welch significance tests, Pearson correlation
   with p-values, concentration analysis) computes a "fact ledger" from the raw CSV.
   Facts carry row-level provenance (which source rows produced them).
2. The narrative layer writes prose around those facts ONLY. Every number in
   AI-written text is audited against the specific fact each scene is bound to, and
   direction language (rose/fell, positive/inverse) is checked against the computed
   sign. Scenes that fail are rewritten deterministically.
3. Every story embeds a signed proof bundle: SHA-256 of the dataset, the fact ledger
   and the story spec, signed with the server's Ed25519 key — verifiable offline.
4. verify_story re-runs the ENTIRE analysis from the raw CSV and returns
   VERIFIED / TAMPERED / UNSUPPORTED_CLAIM / SOURCE_MISMATCH / LEGACY_UNVERIFIED —
   so any agent can independently audit any Plotline story (or catch a forged one).
   VERIFIED requires a proof signed by a pinned trusted key AND structured claims
   on every insight scene; anything missing those protections can never be VERIFIED.

Typical flow: call create_story with raw CSV text. You get a shareable URL to a
self-contained scrollytelling page plus metadata. Use analyze_csv for facts-only JSON,
and verify_story to audit an existing story against its source data.
CSV up to 2 MB / 20,000 rows. No signup, no API key.`;

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "plotline", version: deps.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "create_story",
    {
      title: "Create a data story from CSV",
      description:
        "Turn raw CSV text into a cinematic scrollytelling web page. Runs a deterministic statistics engine (trends, changepoints, outliers, correlations, concentration), builds a verified fact ledger, writes a narrative around only those facts, and returns a shareable URL to a self-contained animated story page. Optionally pass the question the story should answer, a tone, and a visual theme.",
      inputSchema: {
        csv: z.string().min(1).describe("Raw CSV text (max 2 MB, up to 20,000 rows). Headers in the first row."),
        question: z.string().max(300).optional().describe("Optional editorial question the story should answer, e.g. 'What happened to revenue after March?'"),
        tone: z.enum(["documentary", "boardroom", "punchy"]).optional().describe("Narrative voice. Default: documentary."),
        theme: z.enum(["midnight", "paper", "neon"]).optional().describe("Visual theme of the page. Default: midnight."),
        dataset_name: z.string().max(60).optional().describe("Human-friendly name for the dataset, used in the story."),
      },
      outputSchema: {
        storyId: z.string(),
        url: z.string(),
        title: z.string(),
        subtitle: z.string(),
        sceneCount: z.number(),
        factCount: z.number(),
        narrativeMode: z.enum(["ai", "deterministic"]),
        numericAudit: z
          .object({ checked: z.number(), verified: z.number(), rewritten: z.number() })
          .optional(),
      },
    },
    async (args) => {
      try {
        const result = await createStory(
          {
            csv: args.csv,
            question: args.question,
            tone: args.tone,
            theme: args.theme,
            datasetName: args.dataset_name,
          },
          { baseUrl: deps.baseUrl, save: (spec, html) => deps.store.save(spec, html), signer: deps.signer, engine: `plotline@${deps.version}` },
        );
        const s = result.spec;
        const audit = s.numericAudit
          ? `Numeric audit: ${s.numericAudit.verified}/${s.numericAudit.checked} numbers verified` +
            (s.numericAudit.rewritten > 0 ? `, ${s.numericAudit.rewritten} scene(s) rewritten deterministically.` : ".")
          : "Deterministic narration — every sentence generated from computed facts.";
        const text = [
          `# ${s.title}`,
          ``,
          `**Story URL:** ${result.url}`,
          ``,
          `${s.subtitle}`,
          ``,
          `- Scenes: ${s.scenes.length} · Facts in ledger: ${s.facts.length} · Theme: ${s.theme} · Tone: ${s.tone}`,
          `- Narration: ${s.narrativeMode}. ${audit}`,
          `- Machine-readable spec: ${result.url}.json`,
          ``,
          `Share the URL — the page is fully self-contained (no trackers, no external requests).`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            storyId: s.id,
            url: result.url,
            title: s.title,
            subtitle: s.subtitle,
            sceneCount: s.scenes.length,
            factCount: s.facts.length,
            narrativeMode: s.narrativeMode,
            numericAudit: s.numericAudit,
          },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "analyze_csv",
    {
      title: "Analyze CSV into a ranked fact ledger",
      description:
        "Run Plotline's deterministic statistics engine on raw CSV text and return the ranked fact ledger as JSON (trends, changepoints, outliers, streaks, correlations, category leaders, concentration). No story page is rendered — use this when you only need verifiable facts.",
      inputSchema: {
        csv: z.string().min(1).describe("Raw CSV text (max 2 MB)."),
        question: z.string().max(300).optional().describe("Optional focus question — matching columns rank higher."),
        dataset_name: z.string().max(60).optional(),
      },
      outputSchema: {
        rowCount: z.number(),
        columns: z.array(z.object({ name: z.string(), type: z.string() })),
        notes: z.array(z.string()),
        facts: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            headline: z.string(),
            statement: z.string(),
            importance: z.number(),
            columns: z.array(z.string()),
            evidence: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      try {
        const analysis = analyzeCsv(args.csv, args.question, args.dataset_name);
        const top = analysis.facts.slice(0, 8).map((f) => `- **${f.id}** (${f.kind}, ${f.importance}): ${f.statement}`);
        const text = [
          `Analyzed **${analysis.dataset.name}** — ${analysis.dataset.rowCount} rows, ${analysis.dataset.columns.length} columns.`,
          ``,
          `Top facts:`,
          ...top,
          analysis.facts.length > 8 ? `…and ${analysis.facts.length - 8} more in structuredContent.` : ``,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            rowCount: analysis.dataset.rowCount,
            columns: analysis.dataset.columns.map((c) => ({ name: c.name, type: c.type })),
            notes: analysis.dataset.notes,
            facts: analysis.facts.map((f) => ({
              id: f.id,
              kind: f.kind,
              headline: f.headline,
              statement: f.statement,
              importance: f.importance,
              columns: f.columns,
              evidence: f.evidence,
            })),
          },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_story",
    {
      title: "Fetch an existing story",
      description: "Look up a previously created Plotline story by its ID and return its URL and metadata.",
      inputSchema: {
        story_id: z.string().min(4).max(24).describe("The story ID returned by create_story."),
      },
      outputSchema: {
        found: z.boolean(),
        url: z.string().optional(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        createdAt: z.string().optional(),
        sceneCount: z.number().optional(),
        factCount: z.number().optional(),
      },
    },
    async (args) => {
      const spec = deps.store.getSpec(args.story_id.trim());
      if (!spec) {
        return {
          content: [{ type: "text", text: `No story found with id \`${args.story_id.trim()}\`.` }],
          structuredContent: { found: false },
        };
      }
      const url = `${deps.baseUrl}/story/${spec.id}`;
      return {
        content: [{ type: "text", text: `**${spec.title}** — ${url} (${spec.scenes.length} scenes, ${spec.facts.length} facts, created ${spec.createdAt}).` }],
        structuredContent: {
          found: true,
          url,
          title: spec.title,
          subtitle: spec.subtitle,
          createdAt: spec.createdAt,
          sceneCount: spec.scenes.length,
          factCount: spec.facts.length,
        },
      };
    },
  );

  server.registerTool(
    "verify_story",
    {
      title: "Independently verify a story against its source data",
      description:
        "Re-run Plotline's entire deterministic analysis on the original CSV and audit an existing story against it. Checks the signed proof bundle (SHA-256 + Ed25519, pinned trusted keys only), recomputes every fact, and validates every scene claim — structured fields (metric, unit, period, category, operation, direction) field-by-field plus prose (numbers, direction words, metric names). Returns VERIFIED, TAMPERED (facts/spec altered or untrusted signing key), UNSUPPORTED_CLAIM (prose or claim fields not backed by facts), SOURCE_MISMATCH (wrong dataset), or LEGACY_UNVERIFIED (missing proof/claims — never VERIFIED without them). Pass a story_id for a story on this server, or spec_json for any Plotline story spec — including one downloaded from elsewhere.",
      inputSchema: {
        csv: z.string().min(1).describe("The original raw CSV the story claims to be built from."),
        story_id: z.string().min(4).max(24).optional().describe("ID of a story on this server."),
        spec_json: z.string().optional().describe("Alternatively: a full StorySpec JSON (e.g. the downloaded /story/{id}.json)."),
      },
      outputSchema: {
        verdict: z.enum(["VERIFIED", "LEGACY_UNVERIFIED", "TAMPERED", "UNSUPPORTED_CLAIM", "SOURCE_MISMATCH"]),
        storyId: z.string(),
        factsChecked: z.number(),
        claimsChecked: z.number(),
        checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
        engine: z.string(),
      },
    },
    async (args) => {
      try {
        let spec: StorySpec | null = null;
        if (args.story_id) {
          spec = deps.store.getSpec(args.story_id.trim());
          if (!spec) throw new UserError(`No story found with id \`${args.story_id.trim()}\`.`);
        } else if (args.spec_json) {
          try {
            spec = JSON.parse(args.spec_json) as StorySpec;
          } catch {
            throw new UserError("spec_json is not valid JSON.");
          }
          if (!spec || !Array.isArray(spec.facts) || !Array.isArray(spec.scenes)) {
            throw new UserError("spec_json does not look like a Plotline StorySpec (needs facts[] and scenes[]).");
          }
        } else {
          throw new UserError("Provide either story_id or spec_json.");
        }
        const trusted = deps.signer ? trustedKeysFromEnv(deps.signer.publicKey) : [];
        const report = verifyStory(args.csv, spec, `plotline@${deps.version}`, trusted);
        const icon = report.verdict === "VERIFIED" ? "✅" : report.verdict === "LEGACY_UNVERIFIED" ? "⚠️" : "❌";
        const text = [
          `${icon} **${report.verdict}** — story \`${report.storyId}\``,
          ``,
          ...report.checks.map((c) => `- ${c.ok ? "✓" : "✗"} **${c.name}**: ${c.detail}`),
          ``,
          `${report.factsChecked} facts recomputed · ${report.claimsChecked} scene claims audited · ${report.engine}`,
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            verdict: report.verdict,
            storyId: report.storyId,
            factsChecked: report.factsChecked,
            claimsChecked: report.claimsChecked,
            checks: report.checks,
            engine: report.engine,
          },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "list_themes",
    {
      title: "List themes and tones",
      description: "List the visual themes and narrative tones available for create_story.",
      inputSchema: {},
      outputSchema: {
        themes: z.array(z.object({ name: z.string(), description: z.string() })),
        tones: z.array(z.object({ name: z.string(), description: z.string() })),
      },
    },
    async () => {
      const themes = [
        { name: "midnight", description: "Cinematic dark blue — the signature look. Default." },
        { name: "paper", description: "Warm editorial print, serif display — for reports and briefings." },
        { name: "neon", description: "Terminal green on black, monospace — for crypto and dev data." },
      ];
      const tones = [
        { name: "documentary", description: "Measured, narrative, curious. Default." },
        { name: "boardroom", description: "Crisp executive summary voice." },
        { name: "punchy", description: "Short, energetic, social-ready." },
      ];
      return {
        content: [
          {
            type: "text",
            text:
              `**Themes:**\n${themes.map((t) => `- \`${t.name}\` — ${t.description}`).join("\n")}\n\n` +
              `**Tones:**\n${tones.map((t) => `- \`${t.name}\` — ${t.description}`).join("\n")}`,
          },
        ],
        structuredContent: { themes, tones },
      };
    },
  );

  server.registerTool(
    "get_pricing",
    {
      title: "Get pricing and payment info",
      description: "Current pricing: free daily quota and x402 (USDT0 on OKX X Layer) pay-per-story details.",
      inputSchema: {},
      outputSchema: {
        mode: z.string(),
        freeCallsPerDay: z.number(),
        pricePerStoryUsd: z.number(),
        currency: z.string(),
        network: z.string(),
        payTo: z.string(),
      },
    },
    async () => {
      const p = deps.x402;
      const text =
        p.mode === "free"
          ? `Plotline is currently **free**: ${p.freeDaily} courtesy calls/day per client (quota shown in the X-Free-Calls-Remaining header). Paid deployments charge ${p.priceUsd} USDT0 per story via x402 on OKX X Layer.`
          : `Pay-per-call via x402: every unpaid call returns HTTP 402 with a PAYMENT-REQUIRED challenge (${p.priceUsd} USDT0 on OKX X Layer, pay-to ${p.payTo}); pay and the request is replayed.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          mode: p.mode,
          freeCallsPerDay: p.freeDaily,
          pricePerStoryUsd: p.priceUsd,
          currency: "USDT0",
          network: "eip155:196",
          payTo: p.payTo,
        },
      };
    },
  );

  return server;
}

function toolError(err: unknown) {
  const msg = err instanceof UserError ? err.message : "Internal error while building the story. Please retry.";
  if (!(err instanceof UserError)) console.error("[mcp] tool error:", err);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}
