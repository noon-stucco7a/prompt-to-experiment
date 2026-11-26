/**
 * parse.ts — turn one natural-language prompt into a structured draft of
 * an experiment plan.
 *
 * This is a deterministic, rule-based parser (no online LLM at run time),
 * so the same prompt always produces the same draft and a reviewer can
 * reproduce it. Anything the prompt does not state is filled with the
 * documented default from design.md and recorded in `defaultsUsed` so the
 * human reviewer sees exactly what was assumed.
 *
 * Supported prompt shapes (Chinese or English):
 *   "测一下收益型标题对注册转化率的影响"
 *   "Test whether a benefit-led headline lifts signup conversion"
 *   Optional quoted copy: control「...」treatment「...」 / control "..." treatment "..."
 *   Optional split: "五五分流" / "50/50" / "80/20"
 *   Optional sample size: "每组 1000 人" / "1000 per variant"
 */

import type { ExperimentPlan } from "./types.js";

export interface ParsedPrompt {
  /** What is being tested: "headline", "cta", "headline+cta", ... */
  element: string;
  /** Control framing: "feature" (functional description) or "benefit". */
  controlStyle: "feature" | "benefit" | "unknown";
  /** Treatment framing. */
  treatmentStyle: "benefit" | "feature" | "unknown";
  /** Primary metric event name. */
  metricEvent: string;
  /** Primary metric name. */
  metricName: string;
  /** Control copy (headline + CTA). */
  controlCopy: { headline: string; cta: string };
  /** Treatment copy (headline + CTA). */
  treatmentCopy: { headline: string; cta: string };
  /** Hypothesis sentence, or "" when the prompt states none. */
  hypothesis: string;
  /** Split in percent, e.g. { control: 50, treatment: 50 }. */
  allocation: Record<string, number>;
  /** Identities per variant (defaulted to 1000 when the prompt is silent). */
  identitiesPerVariant: number;
  defaultsUsed: ExperimentPlan["defaultsUsed"];
}

const DEFAULT_CONTROL = {
  headline: "Organize your team's work in one place",
  cta: "Start free trial",
};
const DEFAULT_TREATMENT = {
  headline: "Ship projects twice as fast — start today",
  cta: "Get started free",
};

/** Extract text inside 「」, "", or '' quotes, in order of appearance. */
function quotedSegments(prompt: string): string[] {
  const out: string[] = [];
  const re = /[「“"]([^」”"]+)[」”"]|‘([^’]+)’|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function detectSplit(prompt: string): Record<string, number> | null {
  const m = prompt.match(/(\d{1,3})\s*[/:：比]\s*(\d{1,3})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a + b === 100 && a > 0 && b > 0) return { control: a, treatment: b };
  }
  if (/五五|各半|对半|50\s*\/\s*50|均分/.test(prompt)) {
    return { control: 50, treatment: 50 };
  }
  return null;
}

function detectSampleSize(prompt: string): number | null {
  const m = prompt.match(/每组\s*(\d[\d,]*)\s*人|(\d[\d,]*)\s*(?:per|each)\s+variant/i);
  if (m) return Number((m[1] ?? m[2]).replace(/,/g, ""));
  return null;
}

export function parsePrompt(rawPrompt: string): ParsedPrompt {
  const prompt = rawPrompt.trim();
  if (!prompt) throw new Error("empty prompt: pass a natural-language experiment prompt");
  const defaultsUsed: ExperimentPlan["defaultsUsed"] = [];
  const lower = prompt.toLowerCase();

  // ---- element under test ----
  let element = "headline+cta";
  if (/标题|headline|title/.test(prompt)) element = "headline";
  if (/按钮|cta|button/.test(prompt)) element = element === "headline" ? "headline+cta" : "cta";
  if (/副标题|subhead/.test(prompt)) element = "subheadline";
  if (/价格|pricing|price/.test(prompt)) element = "pricing";

  // ---- framing styles ----
  const benefitWords = /收益|收益型|收益承诺|好处|价值|benefit|benefit-led|value/i;
  const featureWords = /功能|功能描述|特性|feature|functional/i;
  const treatmentStyle: ParsedPrompt["treatmentStyle"] =
    benefitWords.test(prompt) ? "benefit" : featureWords.test(prompt) ? "feature" : "unknown";
  const controlStyle: ParsedPrompt["controlStyle"] =
    treatmentStyle === "benefit" ? "feature" : treatmentStyle === "feature" ? "benefit" : "unknown";

  // ---- metric ----
  let metricEvent = "signup_completed";
  let metricName = "signup_rate";
  if (/点击|click|ctr/.test(prompt) && !/注册|转化|signup|conversion/.test(prompt)) {
    metricEvent = "cta_clicked";
    metricName = "cta_click_rate";
  }
  if (/注册|转化|signup|conversion/.test(prompt)) {
    metricEvent = "signup_completed";
    metricName = "signup_rate";
  }

  // ---- copy: quoted segments override defaults ----
  const quotes = quotedSegments(prompt);
  let controlCopy = { ...DEFAULT_CONTROL };
  let treatmentCopy = { ...DEFAULT_TREATMENT };
  if (quotes.length >= 2) {
    // First quoted segment = control headline, second = treatment headline.
    controlCopy = { ...controlCopy, headline: quotes[0] };
    treatmentCopy = { ...treatmentCopy, headline: quotes[1] };
    if (quotes.length >= 4) {
      controlCopy = { ...controlCopy, cta: quotes[2] };
      treatmentCopy = { ...treatmentCopy, cta: quotes[3] };
    }
  } else {
    defaultsUsed.push({
      field: "copy.headline / copy.cta",
      defaultValue: "control: “Organize your team's work in one place” / “Start free trial”; treatment: “Ship projects twice as fast — start today” / “Get started free”",
      note: "Prompt states no explicit copy; using the documented default copy from design.md §2.5. Quote copy in the prompt to override, e.g. control「…」treatment「…」.",
    });
  }

  // ---- hypothesis ----
  const styleLabel =
    treatmentStyle === "benefit"
      ? "收益承诺型"
      : treatmentStyle === "feature"
        ? "功能描述型"
        : "新版";
  const hypothesis =
    `把落地页主标题+CTA 从功能描述型改为${styleLabel}，将使注册转化率从约 10% 提升到至少 13%`;

  // ---- split & sample size ----
  const allocation = detectSplit(prompt) ?? { control: 50, treatment: 50 };
  if (!detectSplit(prompt)) {
    defaultsUsed.push({
      field: "experiment.allocation",
      defaultValue: "control 50 / treatment 50",
      note: "Prompt states no split; defaulting to an even 50/50 split.",
    });
  }
  const identitiesPerVariant = detectSampleSize(prompt) ?? 1000;
  if (detectSampleSize(prompt) === null) {
    defaultsUsed.push({
      field: "simulation.identitiesPerVariant",
      defaultValue: "1000 per variant (2000 total)",
      note: "Prompt states no sample size; 1000/group leaves margin over the ≈686/group required for α=0.05, power=0.8, p1=0.10, p2=0.15 (design.md §3).",
    });
  }

  if (treatmentStyle === "unknown") {
    defaultsUsed.push({
      field: "treatmentStyle",
      defaultValue: "benefit-led treatment vs feature-led control",
      note: "Prompt does not name the treatment framing; assuming a benefit-led treatment against the feature-led control.",
    });
  }
  if (!/假设|hypothesis|提升|lift|影响|effect/i.test(prompt)) {
    defaultsUsed.push({
      field: "experiment.hypothesis",
      defaultValue: hypothesis,
      note: "Prompt states no explicit hypothesis; using the template hypothesis above. Edit it before approving.",
    });
  }

  return {
    element,
    controlStyle,
    treatmentStyle,
    metricEvent,
    metricName,
    controlCopy,
    treatmentCopy,
    hypothesis,
    allocation,
    identitiesPerVariant,
    defaultsUsed,
  };
}
