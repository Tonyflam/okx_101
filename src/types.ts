// ── Plotline shared types ──────────────────────────────────────────────────

export type ColumnType = "number" | "date" | "string" | "boolean";

export interface Column {
  name: string;
  type: ColumnType;
}

/** For date columns the cell is epoch milliseconds. */
export type Cell = number | string | boolean | null;

export interface Dataset {
  name: string;
  columns: Column[];
  rows: Cell[][];
  /** Rows dropped or truncated during parsing, for honesty reporting. */
  notes: string[];
}

// ── Facts (computed, deterministic — the ledger) ───────────────────────────

export type FactKind =
  | "overview"
  | "trend"
  | "delta"
  | "changepoint"
  | "outlier"
  | "volatility"
  | "correlation"
  | "category_leader"
  | "concentration"
  | "extreme"
  | "streak"
  | "seasonal";

export interface Fact {
  id: string; // "F1", "F2", ...
  kind: FactKind;
  /** Short label, e.g. "Revenue is climbing" */
  headline: string;
  /** Canonical, fully-specified sentence with exact numbers. */
  statement: string;
  /** 0..100 — how story-worthy this fact is. */
  importance: number;
  /** Columns involved. */
  columns: string[];
  /** Named numeric values backing the statement (LLM numeric-audit whitelist). */
  values: Record<string, number>;
  /** Method note, e.g. "OLS linear regression, n=18, R²=0.91". */
  evidence: string;
  chart?: ChartSpec;
}

// ── Charts ─────────────────────────────────────────────────────────────────

export type ChartSpec =
  | {
      type: "line";
      xLabel: string;
      yLabel: string;
      /** x is a display label; y numeric. */
      points: { x: string; y: number }[];
      trend?: { slope: number; intercept: number };
      markIndex?: number; // changepoint / outlier marker
    }
  | {
      type: "bar";
      label: string;
      categories: string[];
      values: number[];
      highlightIndex?: number;
    }
  | {
      type: "scatter";
      xLabel: string;
      yLabel: string;
      points: { x: number; y: number }[];
      fit?: { slope: number; intercept: number };
      r: number;
    }
  | {
      type: "donut";
      label: string;
      slices: { label: string; value: number }[];
    }
  | {
      type: "bignum";
      value: string;
      label: string;
      delta?: string; // e.g. "+42% vs start"
      /** Raw numeric value for count-up animation; omit to render static. */
      numeric?: number;
      suffix?: string;
      prefix?: string;
    };

// ── Story spec ─────────────────────────────────────────────────────────────

export type ThemeName = "midnight" | "paper" | "neon";
export type Tone = "documentary" | "boardroom" | "punchy";

export interface HeroScene {
  kind: "hero";
  kicker: string;
  headline: string;
  sub: string;
  stat?: Extract<ChartSpec, { type: "bignum" }>;
}

export interface InsightScene {
  kind: "insight";
  headline: string;
  body: string;
  factIds: string[];
  chart?: ChartSpec;
}

export interface ClosingScene {
  kind: "closing";
  headline: string;
  body: string;
}

export type Scene = HeroScene | InsightScene | ClosingScene;

export interface NumericAudit {
  /** Number tokens checked across AI-written prose. */
  checked: number;
  /** Tokens verified against the fact ledger. */
  verified: number;
  /** Scenes rewritten with the deterministic narrator after failing audit. */
  rewritten: number;
}

export interface StorySpec {
  id: string;
  createdAt: string;
  title: string;
  subtitle: string;
  question?: string;
  theme: ThemeName;
  tone: Tone;
  narrativeMode: "ai" | "deterministic";
  numericAudit?: NumericAudit;
  dataset: {
    name: string;
    rowCount: number;
    columns: Column[];
    notes: string[];
  };
  facts: Fact[];
  scenes: Scene[];
}

export interface CreateStoryInput {
  csv: string;
  question?: string;
  tone?: Tone;
  theme?: ThemeName;
  datasetName?: string;
}

export interface CreateStoryResult {
  spec: StorySpec;
  html: string;
  url: string;
}
