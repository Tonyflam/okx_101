import type {
  ChartSpec,
  Fact,
  FactKind,
  InsightScene,
  NumericAudit,
  Scene,
  StorySpec,
  Tone,
} from "./types.js";
import { fmtNum, fmtPct, truncate } from "./util.js";

// ── Public entry ───────────────────────────────────────────────────────────

export interface NarrativeResult {
  title: string;
  subtitle: string;
  scenes: Scene[];
  narrativeMode: "ai" | "deterministic";
  numericAudit?: NumericAudit;
}

export interface NarrativeContext {
  datasetName: string;
  rowCount: number;
  question?: string;
  tone: Tone;
}

/**
 * Build the story narrative. Facts are selected and ordered deterministically;
 * the AI (when configured) writes prose ONLY around those facts, and every
 * number it writes is audited against the fact ledger. Scenes that fail the
 * audit are rewritten by the deterministic narrator. No key → fully
 * deterministic narration. The service never fails for lack of an LLM.
 */
export async function buildNarrative(facts: Fact[], ctx: NarrativeContext): Promise<NarrativeResult> {
  const sceneFacts = selectSceneFacts(facts);
  const det = deterministicNarrative(facts, sceneFacts, ctx);

  const ai = await aiNarrative(facts, sceneFacts, ctx, det).catch(() => null);
  if (ai) return ai;
  return { ...det, narrativeMode: "deterministic" };
}

// ── Fact selection & arc ordering ──────────────────────────────────────────

const ARC_ORDER: Record<FactKind, number> = {
  overview: 0,
  trend: 1,
  category_leader: 2,
  concentration: 3,
  correlation: 4,
  seasonal: 5,
  volatility: 6,
  streak: 7,
  changepoint: 8, // the twist arrives late
  outlier: 9,
  extreme: 10,
  delta: 1,
} as unknown as Record<FactKind, number>;

export function selectSceneFacts(facts: Fact[]): Fact[] {
  const pool = facts.filter((f) => f.kind !== "overview" && f.importance >= 20);
  const picked: Fact[] = [];
  const perKind = new Map<string, number>();
  const perCol = new Map<string, number>();
  for (const f of pool) {
    if (picked.length >= 7) break;
    const kindCount = perKind.get(f.kind) ?? 0;
    if (kindCount >= 2) continue;
    const primary = f.columns[0] ?? "";
    const colCount = perCol.get(primary) ?? 0;
    if (colCount >= 3) continue;
    picked.push(f);
    perKind.set(f.kind, kindCount + 1);
    perCol.set(primary, colCount + 1);
  }
  // Guarantee at least 3 scenes when data is thin.
  if (picked.length < 3) {
    for (const f of pool) {
      if (picked.length >= 3) break;
      if (!picked.includes(f)) picked.push(f);
    }
  }
  return picked.sort((a, b) => (ARC_ORDER[a.kind] ?? 5) - (ARC_ORDER[b.kind] ?? 5) || b.importance - a.importance);
}

// ── Hero stat ──────────────────────────────────────────────────────────────

function heroStat(sceneFacts: Fact[]): Extract<ChartSpec, { type: "bignum" }> | undefined {
  for (const f of sceneFacts) {
    if (f.kind === "trend" && Math.abs(f.values.changePct ?? 0) >= 5) {
      return {
        type: "bignum",
        value: fmtPct(f.values.changePct as number),
        numeric: f.values.changePct,
        suffix: "%",
        prefix: (f.values.changePct as number) > 0 ? "+" : "",
        label: `${f.columns[0]} · start to end`,
      };
    }
    if (f.kind === "category_leader" && (f.values.share ?? 0) >= 25) {
      return {
        type: "bignum",
        value: `${fmtNum(f.values.share as number)}%`,
        numeric: f.values.share,
        suffix: "%",
        label: `of ${f.columns[1]} from one ${f.columns[0]}`,
      };
    }
    if (f.kind === "changepoint") {
      return {
        type: "bignum",
        value: fmtPct(f.values.shiftPct as number),
        numeric: f.values.shiftPct,
        suffix: "%",
        prefix: (f.values.shiftPct as number) > 0 ? "+" : "",
        label: `level shift in ${f.columns[0]}`,
      };
    }
    if (f.kind === "correlation") {
      return {
        type: "bignum",
        value: (f.values.r as number).toFixed(2),
        numeric: f.values.r,
        label: `correlation: ${f.columns[0]} × ${f.columns[1]}`,
      };
    }
  }
  return undefined;
}

// ── Deterministic narrator ─────────────────────────────────────────────────

const OPENERS: Record<Tone, string[]> = {
  documentary: [
    "The picture opens wide.",
    "Look closer and a pattern emerges.",
    "Beneath the surface, the data keeps talking.",
    "There is a quieter thread running through it.",
    "Then the pattern breaks.",
    "One moment refuses to fit.",
    "And a rhythm reveals itself.",
  ],
  boardroom: [
    "Bottom line first.",
    "The driver behind it:",
    "Worth flagging for the room:",
    "The dependency to watch:",
    "Now the inflection.",
    "One number demands an explanation.",
    "And the cadence matters.",
  ],
  punchy: [
    "Here's the headline.",
    "Now meet the main character.",
    "Plot thickens.",
    "These two are clearly texting.",
    "Then everything changed.",
    "Hold on — what happened here?",
    "And the data has a heartbeat.",
  ],
};

const KICKERS: Record<FactKind, Record<Tone, string>> = {
  trend: {
    documentary: "Movement this consistent is rarely an accident — something underneath is compounding.",
    boardroom: "Trajectory, not position, is the strategic fact here.",
    punchy: "That's not a blip. That's a direction.",
  },
  changepoint: {
    documentary: "Whatever happened here, the data never returned to its old normal.",
    boardroom: "Find the operational event behind this date — it changed the baseline.",
    punchy: "Before and after. Two different worlds.",
  },
  outlier: {
    documentary: "Every dataset keeps one moment it cannot explain. This is this one's.",
    boardroom: "Verify this point before it distorts any average you report.",
    punchy: "One point said: watch me.",
  },
  correlation: {
    documentary: "Correlation is not causation — but it is always a question worth asking.",
    boardroom: "If this link is causal, it's a lever. If not, it's a risk of false reads.",
    punchy: "Coincidence? The scatter plot doesn't think so.",
  },
  category_leader: {
    documentary: "Averages hide hierarchies. Grouping the data reveals who actually carries it.",
    boardroom: "Concentration of this kind is either a moat or a single point of failure.",
    punchy: "Not all heroes wear capes. Some just top the chart.",
  },
  concentration: {
    documentary: "A long tail, and a very short head.",
    boardroom: "Diversification — or the lack of it — starts exactly here.",
    punchy: "The 80/20 rule called. It wants credit.",
  },
  seasonal: {
    documentary: "Time leaves fingerprints; the calendar is one of them.",
    boardroom: "Schedule decisions against this rhythm, not against the average.",
    punchy: "The calendar is pulling strings back there.",
  },
  volatility: {
    documentary: "The average tells you little when the swings are the story.",
    boardroom: "Plan for the range, not the mean.",
    punchy: "Buckle up — this metric doesn't do calm.",
  },
  streak: {
    documentary: "Momentum, once visible, is hard to unsee.",
    boardroom: "Streaks end; the question is what you do before they do.",
    punchy: "A streak like that starts feeling personal.",
  },
  extreme: {
    documentary: "The boundaries of the data, for the record.",
    boardroom: "These are your reference points for any target-setting.",
    punchy: "Records exist to be noticed.",
  },
  overview: {
    documentary: "",
    boardroom: "",
    punchy: "",
  },
  delta: {
    documentary: "",
    boardroom: "",
    punchy: "",
  },
} as Record<FactKind, Record<Tone, string>>;

function deterministicTitle(sceneFacts: Fact[], ctx: NarrativeContext): { title: string; subtitle: string } {
  const top = [...sceneFacts].sort((a, b) => b.importance - a.importance)[0];
  const name = ctx.datasetName;
  if (!top) return { title: `The story inside ${name}`, subtitle: `${ctx.rowCount} rows, read closely.` };
  const col = top.columns[0] ?? "the data";
  let title: string;
  switch (top.kind) {
    case "trend":
      title = (top.values.changePct ?? 0) >= 0 ? `The rise of ${col}` : `The slide in ${col}`;
      break;
    case "changepoint":
      title = `The day ${col} changed`;
      break;
    case "outlier":
      title = `${col}, and the moment that broke the pattern`;
      break;
    case "correlation":
      title = `${top.columns[0]} & ${top.columns[1]}: a duet`;
      break;
    case "category_leader":
    case "concentration":
      title = `Who really drives ${top.columns[1] ?? col}`;
      break;
    case "seasonal":
      title = `${col} runs on a clock`;
      break;
    default:
      title = `The story inside ${name}`;
  }
  const subtitle = ctx.question
    ? `Asked of the data: “${truncate(ctx.question, 120)}”`
    : `${ctx.rowCount} rows of ${name}, distilled into the ${sceneFacts.length} findings that matter.`;
  return { title: truncate(title, 90), subtitle };
}

export function deterministicNarrative(
  allFacts: Fact[],
  sceneFacts: Fact[],
  ctx: NarrativeContext,
): { title: string; subtitle: string; scenes: Scene[] } {
  const { title, subtitle } = deterministicTitle(sceneFacts, ctx);
  const openers = OPENERS[ctx.tone];
  const scenes: Scene[] = [];

  scenes.push({
    kind: "hero",
    kicker: "A Plotline data story",
    headline: title,
    sub: subtitle,
    stat: heroStat(sceneFacts),
  });

  sceneFacts.forEach((f, i) => {
    const opener = openers[i % openers.length] as string;
    let kicker = KICKERS[f.kind]?.[ctx.tone] ?? "";
    // A noisy trend shouldn't get the "consistent" kicker.
    if (f.kind === "trend" && typeof f.values.r2 === "number" && f.values.r2 < 0.5) {
      kicker =
        ctx.tone === "boardroom"
          ? "The direction is clear even if the path is not; treat the slope, not the noise, as the signal."
          : ctx.tone === "punchy"
            ? "Messy path, clear direction."
            : "The route was noisy, but the destination was not in doubt.";
    }
    scenes.push({
      kind: "insight",
      headline: f.headline,
      body: `${opener} ${f.statement}${kicker ? " " + kicker : ""}`,
      factIds: [f.id],
      chart: f.chart,
    });
  });

  scenes.push({
    kind: "closing",
    headline: "Every number above is verified",
    body:
      `This story was assembled from ${ctx.rowCount} rows and ${allFacts.length} machine-computed facts. ` +
      `Numbers come from code; words follow the numbers — never the reverse. ` +
      `The full fact ledger, with methods, is below.`,
  });

  return { title, subtitle, scenes };
}

// ── AI narrator (optional layer) ───────────────────────────────────────────

interface LlmSceneDraft {
  headline: string;
  body: string;
}

interface LlmDraft {
  title: string;
  subtitle: string;
  scenes: LlmSceneDraft[];
  closingHeadline: string;
  closingBody: string;
}

async function aiNarrative(
  allFacts: Fact[],
  sceneFacts: Fact[],
  ctx: NarrativeContext,
  det: { title: string; subtitle: string; scenes: Scene[] },
): Promise<NarrativeResult | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";

  const payload = {
    dataset: ctx.datasetName,
    rows: ctx.rowCount,
    question: ctx.question ?? null,
    tone: ctx.tone,
    scenes: sceneFacts.map((f, i) => ({
      scene: i + 1,
      factId: f.id,
      kind: f.kind,
      statement: f.statement,
      values: f.values,
      evidence: f.evidence,
    })),
  };

  const system = [
    "You are Plotline's narrator: a world-class data journalist.",
    "You will receive a scene plan: an ordered list of VERIFIED facts.",
    "Write the story around exactly these facts, in this order.",
    "HARD RULES:",
    "1. Use ONLY numbers that appear in each scene's fact values or statement. Never invent, extrapolate, or compute new numbers.",
    "2. One scene per fact, same order. Do not merge, drop, or reorder scenes.",
    "3. Each scene: a headline (≤60 chars) and a body of 2–3 sentences (≤380 chars).",
    `4. Match the requested tone: ${ctx.tone}.`,
    "5. Speculation must be clearly framed as a question, never as a claim.",
    "6. Respond with pure JSON, no markdown fences, exactly this shape:",
    '{"title": string, "subtitle": string, "scenes": [{"headline": string, "body": string}], "closingHeadline": string, "closingBody": string}',
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let raw: string;
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 1600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    raw = data.choices?.[0]?.message?.content ?? "";
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const draft = parseDraft(raw, sceneFacts.length);
  if (!draft) return null;

  // ── Semantic audit: every number AND every direction the AI wrote must ──
  // ── be supported by the specific fact each scene is bound to. ──────────
  const audit: NumericAudit = { checked: 0, verified: 0, rewritten: 0, semanticRejected: 0 };
  const structural = structuralWhitelist(sceneFacts, allFacts.length, ctx);

  const scenes: Scene[] = [];
  const heroOk = auditText(`${draft.title} ${draft.subtitle}`, structural, audit);
  scenes.push({
    kind: "hero",
    kicker: "A Plotline data story",
    headline: heroOk ? truncate(draft.title, 90) : det.title,
    sub: heroOk ? truncate(draft.subtitle, 160) : det.subtitle,
    stat: heroStat(sceneFacts),
  });

  sceneFacts.forEach((f, i) => {
    const d = draft.scenes[i]!;
    const claim = auditClaimText(f, `${d.headline} ${d.body}`, audit);
    const ok = claim.ok;
    const detScene = det.scenes[i + 1] as InsightScene; // same order, offset by hero
    scenes.push({
      kind: "insight",
      headline: ok ? truncate(d.headline, 80) : detScene.headline,
      body: ok ? truncate(d.body, 420) : detScene.body,
      factIds: [f.id],
      chart: f.chart,
    });
    if (!ok) audit.rewritten++;
  });

  const closingOk = auditText(`${draft.closingHeadline} ${draft.closingBody}`, structural, audit);
  const detClosing = det.scenes[det.scenes.length - 1] as Extract<Scene, { kind: "closing" }>;
  scenes.push({
    kind: "closing",
    headline: closingOk ? truncate(draft.closingHeadline, 80) : detClosing.headline,
    body:
      (closingOk ? truncate(draft.closingBody, 420) : detClosing.body) +
      ` Numbers come from code; words follow the numbers — never the reverse.`,
  });

  const title = heroOk ? truncate(draft.title, 90) : det.title;
  const subtitle = heroOk ? truncate(draft.subtitle, 160) : det.subtitle;
  return { title, subtitle, scenes, narrativeMode: "ai", numericAudit: audit };
}

function parseDraft(raw: string, expectedScenes: number): LlmDraft | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = (fence[1] as string).trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Partial<LlmDraft> & { scenes?: unknown };
    if (typeof obj.title !== "string" || typeof obj.subtitle !== "string") return null;
    if (!Array.isArray(obj.scenes) || obj.scenes.length !== expectedScenes) return null;
    const scenes: LlmSceneDraft[] = [];
    for (const sc of obj.scenes) {
      const o = sc as Partial<LlmSceneDraft>;
      if (typeof o.headline !== "string" || typeof o.body !== "string") return null;
      scenes.push({ headline: o.headline, body: o.body });
    }
    return {
      title: obj.title,
      subtitle: obj.subtitle,
      scenes,
      closingHeadline: typeof obj.closingHeadline === "string" ? obj.closingHeadline : "The story, verified",
      closingBody: typeof obj.closingBody === "string" ? obj.closingBody : "",
    };
  } catch {
    return null;
  }
}

// ── Numeric + semantic audit machinery ──────────────────────────────────────

/**
 * Structural numbers allowed in hero/closing prose: tiny rhetorical ints,
 * plausible years, the row/fact counts, and the numbers of the facts that
 * actually appear in the story. NOT the whole ledger — a number from an
 * unused fact cannot leak into the title.
 */
function structuralWhitelist(sceneFacts: Fact[], factCount: number, ctx: NarrativeContext): Set<number> {
  const s = smallStructural();
  s.add(ctx.rowCount);
  s.add(factCount);
  for (const f of sceneFacts) for (const v of factAllowedNumbers(f)) s.add(v);
  return s;
}

/** Tiny rhetorical ints + plausible years. (The old 0–12 freebie is gone —
 * "seven straight quarters" must now be backed by the bound fact.) */
function smallStructural(): Set<number> {
  const s = new Set<number>([0, 1, 2, 3]);
  for (let y = 1990; y <= 2035; y++) s.add(y);
  return s;
}

export function factAllowedNumbers(f: Fact): Set<number> {
  const s = new Set<number>();
  for (const v of Object.values(f.values)) addForms(s, v);
  // Numbers appearing in the canonical statement (they are formatted).
  for (const tok of extractNumbers(f.statement)) s.add(tok);
  return s;
}

function addForms(s: Set<number>, v: number): void {
  if (!Number.isFinite(v)) return;
  s.add(v);
  s.add(Math.abs(v));
  s.add(Math.round(v));
  s.add(Math.abs(Math.round(v)));
  s.add(Math.round(v * 10) / 10);
  s.add(Math.abs(Math.round(v * 10) / 10));
  // Compact forms the model might echo from formatted text: 1.2M -> 1.2
  const abs = Math.abs(v);
  if (abs >= 1e9) { s.add(round2(abs / 1e9)); s.add(round1(abs / 1e9)); }
  if (abs >= 1e6) { s.add(round2(abs / 1e6)); s.add(round1(abs / 1e6)); }
  if (abs >= 1e3) { s.add(round2(abs / 1e3)); s.add(round1(abs / 1e3)); }
}

export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(Math.abs(n));
  }
  return out;
}

/** True when every number in the text is present in the allowed set (with tolerance). */
export function auditText(text: string, allowed: Set<number>, audit: NumericAudit): boolean {
  const nums = extractNumbers(text);
  let ok = true;
  for (const n of nums) {
    audit.checked++;
    let hit = false;
    for (const a of allowed) {
      const abs = Math.abs(a);
      if (Math.abs(n - abs) <= 0.05 || (abs > 0 && Math.abs(n - abs) / abs <= 0.015)) {
        hit = true;
        break;
      }
    }
    if (hit) audit.verified++;
    else ok = false;
  }
  return ok;
}

// ── Semantic claim audit (numbers + direction, bound to ONE fact) ─────────

const UP_WORDS =
  /\b(rise|rises|rose|risen|rising|climb(?:s|ed|ing)?|grew|grow(?:s|ing|th)?|increas(?:e|es|ed|ing)|gain(?:s|ed)?|jump(?:s|ed|ing)?|surg(?:e|es|ed|ing)|rall(?:y|ies|ied)|soar(?:s|ed|ing)?|accelerat(?:e|es|ed|ing)|upward)\b/i;
const DOWN_WORDS =
  /\b(fall|falls|fell|fallen|falling|drop(?:s|ped|ping)?|declin(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|shrink(?:s|ing)?|shrank|shrunk|plung(?:e|es|ed|ing)|slid|slide(?:s)?|sliding|sank|sink(?:s|ing)?|slump(?:s|ed|ing)?|downward|los(?:t|ing|s)\b|deteriorat(?:e|es|ed|ing))\b/i;
const NEGATIVE_CORR = /\b(invers(?:e|ely)|negative(?:ly)?|opposite|anti-?correlat)/i;
const POSITIVE_CORR = /\b(positive(?:ly)?|lockstep|in\s+tandem)\b/i;

/**
 * Direction of a fact, derived from its computed values — never from a
 * mutable label, so a tampered spec cannot lie about it.
 */
export function factDirection(f: Fact): "up" | "down" | "flat" | null {
  switch (f.kind) {
    case "trend":
    case "delta":
    case "streak": {
      const pct = f.values.changePct;
      if (typeof pct !== "number") return null;
      return pct > 3 ? "up" : pct < -3 ? "down" : "flat";
    }
    case "changepoint": {
      const shift = f.values.shiftPct ?? (typeof f.values.after === "number" && typeof f.values.before === "number" ? f.values.after - f.values.before : undefined);
      if (typeof shift !== "number") return null;
      return shift > 0 ? "up" : shift < 0 ? "down" : "flat";
    }
    default:
      return null;
  }
}

export interface ClaimAudit {
  ok: boolean;
  reason?: string;
}

/**
 * Audit prose against the ONE fact it claims to describe:
 * 1. every number must come from that fact (plus tiny structural ints/years);
 * 2. the direction language must not contradict the fact's computed direction;
 * 3. correlation sign words must match the computed r.
 * Used at generation time (AI scenes) and at verification time (verify_story).
 */
export function auditClaimText(f: Fact, text: string, audit?: NumericAudit): ClaimAudit {
  const counters: NumericAudit = audit ?? { checked: 0, verified: 0, rewritten: 0 };
  const allowed = new Set([...factAllowedNumbers(f), ...smallStructural()]);
  const numbersOk = auditText(text, allowed, counters);
  if (!numbersOk) {
    return { ok: false, reason: `contains a number not present in fact ${f.id} (${f.kind})` };
  }
  const dir = factDirection(f);
  if (dir === "up" && DOWN_WORDS.test(text) && !UP_WORDS.test(text)) {
    if (audit) audit.semanticRejected = (audit.semanticRejected ?? 0) + 1;
    return { ok: false, reason: `claims a decline but fact ${f.id} measured an increase` };
  }
  if (dir === "down" && UP_WORDS.test(text) && !DOWN_WORDS.test(text)) {
    if (audit) audit.semanticRejected = (audit.semanticRejected ?? 0) + 1;
    return { ok: false, reason: `claims an increase but fact ${f.id} measured a decline` };
  }
  if (f.kind === "correlation" && typeof f.values.r === "number") {
    if (f.values.r > 0 && NEGATIVE_CORR.test(text)) {
      if (audit) audit.semanticRejected = (audit.semanticRejected ?? 0) + 1;
      return { ok: false, reason: `claims an inverse relationship but fact ${f.id} computed r=${f.values.r} (positive)` };
    }
    if (f.values.r < 0 && POSITIVE_CORR.test(text)) {
      if (audit) audit.semanticRejected = (audit.semanticRejected ?? 0) + 1;
      return { ok: false, reason: `claims a positive relationship but fact ${f.id} computed r=${f.values.r} (inverse)` };
    }
  }
  return { ok: true };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
