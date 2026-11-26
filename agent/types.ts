/**
 * Shared types for the Prompt-to-Experiment agent.
 *
 * One experiment plan is the single source of truth: parse.ts fills it,
 * plan.ts serialises it, approve.ts gates on it, apply.ts realises it in
 * Flagsmith, run-sim.ts replays traffic against it and report.ts judges it.
 */

export interface VariantCopy {
  /** Human-readable label, e.g. "control" / "treatment". */
  key: string;
  /** Headline shown on the landing page. */
  headline: string;
  /** CTA button label. */
  cta: string;
}

export interface MetricDefinition {
  name: string;
  /** Flagsmith aggregation, e.g. "occurrence". */
  aggregation: string;
  /** "up" (higher is better) or "down". */
  direction: "up" | "down";
  /** SDK event name. Case-sensitive; must match trackEvent() exactly. */
  event: string;
}

export interface ExperimentPlan {
  version: 1;
  generatedAt: string;
  /** The raw natural-language prompt this plan was derived from. */
  prompt: string;

  flag: {
    /** Multivariate flag name, e.g. "landing_cta". */
    name: string;
    /** Value served when no variant is assigned (the control value). */
    defaultValue: string;
    variants: { key: string; value: string }[];
  };

  /** Primary metric: the only metric the conclusion is drawn from. */
  metric: MetricDefinition;
  /** Secondary metric: observed only, never used for the conclusion. */
  secondaryMetric: MetricDefinition;

  experiment: {
    name: string;
    hypothesis: string;
    /** Percent of traffic enrolled in the experiment. */
    rolloutPercentage: number;
    /** Percentage allocation per variant key; must sum to 100. */
    allocation: Record<string, number>;
  };

  /** Copy per variant, keyed by variant key. */
  copy: Record<string, VariantCopy>;

  /** Simulation parameters (declared in the plan so a run is reproducible). */
  simulation: {
    identitiesPerVariant: number;
    totalIdentities: number;
    /** Fixed PRNG seed; the dice rolls are reproducible. */
    seed: number;
    /** Assumed true conversion rates per variant (simulation ground truth). */
    trueRates: Record<string, number>;
  };

  /**
   * Fields the parser could not extract from the prompt and filled with
   * defaults. Each entry names the field and the default that was used, so
   * the human reviewer can spot and correct them in plan-summary.md.
   */
  defaultsUsed: { field: string; defaultValue: string; note: string }[];
}
