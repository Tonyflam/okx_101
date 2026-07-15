import { parseCsv } from "./csv.js";
import { extractFacts } from "./insights.js";
import { buildNarrative } from "./narrative.js";
import { buildProof, type ProofSigner } from "./proof.js";
import { buildStoryHtml } from "./renderer.js";
import type { CreateStoryInput, CreateStoryResult, StorySpec, ThemeName, Tone } from "./types.js";
import { newStoryId, truncate } from "./util.js";

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB

const THEMES: ThemeName[] = ["midnight", "paper", "neon"];
const TONES: Tone[] = ["documentary", "boardroom", "punchy"];

export interface PipelineDeps {
  baseUrl: string;
  save: (spec: StorySpec, html: string) => void;
  /** When present, stories carry a signed proof bundle. */
  signer?: ProofSigner;
  /** Engine identity embedded in proofs, e.g. "plotline@1.1.0". */
  engine?: string;
}

/** The whole product in one function: CSV → facts → narrative → story. */
export async function createStory(input: CreateStoryInput, deps: PipelineDeps): Promise<CreateStoryResult> {
  const csv = String(input.csv ?? "");
  if (!csv.trim()) throw new UserError("`csv` is required and cannot be empty.");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    throw new UserError("CSV too large — the limit is 2 MB.");
  }
  const theme = THEMES.includes(input.theme as ThemeName) ? (input.theme as ThemeName) : "midnight";
  const tone = TONES.includes(input.tone as Tone) ? (input.tone as Tone) : "documentary";
  const datasetName = truncate((input.datasetName ?? "").trim() || "uploaded data", 60);
  const question = input.question ? truncate(String(input.question).trim(), 300) : undefined;

  let dataset;
  try {
    dataset = parseCsv(csv, datasetName);
  } catch (err) {
    throw new UserError(`Could not parse CSV: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  const facts = extractFacts(dataset, question);
  if (facts.length < 2) {
    throw new UserError("Not enough signal in this dataset to build a story — need at least one numeric column with 3+ values.");
  }

  const narrative = await buildNarrative(facts, {
    datasetName: dataset.name,
    rowCount: dataset.rows.length,
    question,
    tone,
  });

  const spec: StorySpec = {
    id: newStoryId(),
    createdAt: new Date().toISOString(),
    title: narrative.title,
    subtitle: narrative.subtitle,
    question,
    theme,
    tone,
    narrativeMode: narrative.narrativeMode,
    numericAudit: narrative.numericAudit,
    dataset: {
      name: dataset.name,
      rowCount: dataset.rows.length,
      columns: dataset.columns,
      notes: dataset.notes,
    },
    facts,
    scenes: narrative.scenes,
  };

  if (deps.signer) {
    spec.proof = buildProof(csv, spec, deps.signer, deps.engine ?? "plotline");
  }

  const html = buildStoryHtml(spec, deps.baseUrl);
  deps.save(spec, html);
  return { spec, html, url: `${deps.baseUrl}/story/${spec.id}` };
}

/** Analysis without rendering — the cheaper tool. */
export function analyzeCsv(csv: string, question?: string, datasetName?: string) {
  if (!csv?.trim()) throw new UserError("`csv` is required and cannot be empty.");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw new UserError("CSV too large — the limit is 2 MB.");
  const dataset = parseCsv(csv, truncate((datasetName ?? "").trim() || "uploaded data", 60));
  const facts = extractFacts(dataset, question ? truncate(question, 300) : undefined);
  return {
    dataset: {
      name: dataset.name,
      rowCount: dataset.rows.length,
      columns: dataset.columns,
      notes: dataset.notes,
    },
    facts: facts.map(({ chart: _chart, ...rest }) => rest),
  };
}

/** Errors safe to show to callers (4xx). */
export class UserError extends Error {}
