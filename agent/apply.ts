/**
 * apply.ts — realise an approved experiment-plan.json in Flagsmith.
 *
 * Runs ONLY after approval gate 1 has passed (cli.ts enforces this by
 * requiring --approved-gate-1, which is only printed by a successful gate
 * run — the gate itself never calls this module).
 *
 * Implementation: the Flagsmith CLI v2 (`flagsmith`) with the CLI login
 * credentials (interactive `flagsmith login`, done by a human). No API key
 * is stored in this repo.
 *   - flag + variant: `flagsmith feature create` / `feature variant add`
 *   - metric + experiment: `flagsmith api api/v1/environments/<env-key>/...`
 *     (no dedicated CLI subcommand exists for those two objects yet)
 *
 * Idempotent: each object is listed first; if a same-name object already
 * exists it is reported and reused, never duplicated.
 *
 * --dry-run prints the exact commands that would run, without executing
 * anything and without needing credentials. Use it to review before gate 1.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExperimentPlan } from "./types.js";

export interface ApplyOptions {
  planPath: string;
  /** Project id or name the CLI is bound to (default: from flagsmith.json). */
  project?: string;
  /** Client-side environment key (Development). Required for metric/experiment. */
  environmentKey?: string;
  /** Print commands only; execute nothing; needs no credentials. */
  dryRun?: boolean;
}

export interface PlannedStep {
  label: string;
  command: string[];
}

function metricPayload(plan: ExperimentPlan): Record<string, unknown> {
  return {
    name: plan.metric.name,
    aggregation: plan.metric.aggregation,
    direction: plan.metric.direction,
    definition: { version: 1, event: plan.metric.event },
  };
}

function experimentPayload(plan: ExperimentPlan, flagId: number, metricId: number): Record<string, unknown> {
  const treatment = plan.flag.variants[0];
  return {
    feature: flagId,
    name: plan.experiment.name,
    hypothesis: plan.experiment.hypothesis,
    metrics: [{ metric: metricId, expected_direction: "increase" }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: plan.experiment.rolloutPercentage,
      feature_state_value: { type: "string", value: plan.flag.defaultValue },
      multivariate_feature_state_values: [
        // The variant id is resolved at apply time (see applyPlan); the
        // placeholder is replaced with the real multivariate option id.
        { multivariate_feature_option: "__TREATMENT_VARIANT_ID__", percentage_allocation: plan.experiment.allocation.treatment },
      ],
    },
    _note: `treatment variant key: ${treatment.key}`,
  };
}

/** Build the ordered list of steps for a plan. Pure function — testable. */
export function planSteps(plan: ExperimentPlan, opts: { project?: string; environmentKey?: string }): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const projectArgs = opts.project ? ["-p", opts.project] : [];

  steps.push({
    label: `1. 创建 multivariate flag \`${plan.flag.name}\`（若已存在则复用）`,
    command: ["flagsmith", ...projectArgs, "feature", "create", plan.flag.name, "--value", plan.flag.defaultValue, "--enabled"],
  });
  for (const v of plan.flag.variants) {
    steps.push({
      label: `2. 为 flag 加变体 \`${v.key}\`（若已存在则复用）`,
      command: ["flagsmith", ...projectArgs, "feature", "variant", "add", plan.flag.name, "--value", v.value, "--key", v.key, "--weight", "0"],
    });
  }
  if (!opts.environmentKey) {
    throw new Error("environmentKey is required for metric/experiment steps (FLAGSMITH_ENVIRONMENT_KEY in .env)");
  }
  const env = opts.environmentKey;
  steps.push({
    label: `3. 创建 metric \`${plan.metric.name}\`（事件 ${plan.metric.event}）`,
    command: [
      "flagsmith", "api", `api/v1/environments/${env}/experiment-metrics/`,
      "--input", "-",
    ],
  });
  steps.push({
    label: `4. 创建 experiment \`${plan.experiment.name}\`（draft，不启动）`,
    command: [
      "flagsmith", "api", `api/v1/environments/${env}/experiments/`,
      "--input", "-",
    ],
  });
  return steps;
}

export function loadPlan(planPath: string): ExperimentPlan {
  return JSON.parse(readFileSync(planPath, "utf-8")) as ExperimentPlan;
}

function asList<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === "object" && Array.isArray((x as { results?: unknown }).results)) {
    return (x as { results: T[] }).results;
  }
  throw new Error(`期望列表响应，得到：${JSON.stringify(x)?.slice(0, 200)}`);
}

function run(cmd: string[], stdin?: string): string {
  return execFileSync(cmd[0], cmd.slice(1), {
    encoding: "utf-8",
    input: stdin,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Execute the plan. In dry-run mode only the commands are printed.
 * Returns the ids of the objects created/reused (flag, metric, experiment).
 */
export function applyPlan(plan: ExperimentPlan, opts: ApplyOptions): { flagId: number | null; metricId: number | null; experimentId: number | null } {
  const steps = planSteps(plan, { project: opts.project, environmentKey: opts.environmentKey });
  const out: { flagId: number | null; metricId: number | null; experimentId: number | null } = {
    flagId: null,
    metricId: null,
    experimentId: null,
  };

  if (opts.dryRun) {
    console.log("# --dry-run：以下命令将被执行（未实际执行，未调用任何 API）\n");
    for (const s of steps) {
      console.log(`# ${s.label}`);
      console.log(s.command.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" "));
      console.log();
    }
    console.log("# metric payload:");
    console.log(JSON.stringify(metricPayload(plan), null, 2));
    console.log("\n# experiment payload (variant id resolved at apply time):");
    console.log(JSON.stringify(experimentPayload(plan, 0, 0), null, 2));
    return out;
  }

  // 1. flag (idempotent: list first)
  const existing = JSON.parse(
    run(["flagsmith", ...(opts.project ? ["-p", opts.project] : []), "feature", "list", "--json"]),
  ) as { name: string; id: number }[];
  const found = existing.find((f) => f.name === plan.flag.name);
  if (found) {
    console.log(`flag \`${plan.flag.name}\` 已存在（id=${found.id}），复用。`);
    out.flagId = found.id;
  } else {
    const created = JSON.parse(run(steps[0].command.concat("--json"))) as { id: number };
    out.flagId = created.id;
    console.log(`flag \`${plan.flag.name}\` 已创建（id=${created.id}）。`);
  }

  // 2. variants
  for (const v of plan.flag.variants) {
    const variants = JSON.parse(
      run(["flagsmith", ...(opts.project ? ["-p", opts.project] : []), "feature", "variant", "list", plan.flag.name, "--json"]),
    ) as { key: string; id: number }[];
    if (variants.some((x) => x.key === v.key)) {
      console.log(`变体 \`${v.key}\` 已存在，复用。`);
    } else {
      run(["flagsmith", ...(opts.project ? ["-p", opts.project] : []), "feature", "variant", "add", plan.flag.name, "--value", v.value, "--key", v.key, "--weight", "0"]);
      console.log(`变体 \`${v.key}\` 已创建。`);
    }
  }

  // 3. metric (idempotent: list first)
  const env = opts.environmentKey!;
  const metrics = asList<{ name: string; id: number }>(
    JSON.parse(
      run(["flagsmith", "api", `api/v1/environments/${env}/experiment-metrics/`]),
    ),
  );
  const existingMetric = metrics.find((m) => m.name === plan.metric.name);
  if (existingMetric) {
    console.log(`metric \`${plan.metric.name}\` 已存在（id=${existingMetric.id}），复用。`);
    out.metricId = existingMetric.id;
  } else {
    const created = JSON.parse(run(steps[2].command, JSON.stringify(metricPayload(plan)))) as { id: number };
    out.metricId = created.id;
    console.log(`metric \`${plan.metric.name}\` 已创建（id=${created.id}）。`);
  }

  // 4. experiment (idempotent: list first; needs the treatment variant id)
  const experiments = asList<{ name: string; id: number }>(
    JSON.parse(
      run(["flagsmith", "api", `api/v1/environments/${env}/experiments/`]),
    ),
  );
  const existingExp = experiments.find((e) => e.name === plan.experiment.name);
  if (existingExp) {
    console.log(`experiment \`${plan.experiment.name}\` 已存在（id=${existingExp.id}），复用，不启动。`);
    out.experimentId = existingExp.id;
    return out;
  }
  const variants = JSON.parse(
    run(["flagsmith", ...(opts.project ? ["-p", opts.project] : []), "feature", "variant", "list", plan.flag.name, "--json"]),
  ) as { key: string; id: number }[];
  const treatment = variants.find((x) => x.key === plan.flag.variants[0].key);
  if (!treatment) throw new Error(`找不到变体 ${plan.flag.variants[0].key}，无法创建 experiment`);
  if (out.flagId === null || out.metricId === null) throw new Error("flag/metric id 缺失，无法创建 experiment");
  const payload = experimentPayload(plan, out.flagId, out.metricId);
  payload.experiment_rollout = {
    ...(payload.experiment_rollout as Record<string, unknown>),
    multivariate_feature_state_values: [
      { multivariate_feature_option: treatment.id, percentage_allocation: plan.experiment.allocation.treatment },
    ],
  };
  delete payload._note;
  const created = JSON.parse(run(steps[3].command, JSON.stringify(payload))) as { id: number; status?: string };
  out.experimentId = created.id;
  console.log(`experiment \`${plan.experiment.name}\` 已创建（id=${created.id}，状态 draft，未启动）。`);
  return out;
}
