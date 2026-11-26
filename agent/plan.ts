/**
 * plan.ts — build experiment-plan.json (machine-readable draft) and
 * plan-summary.md (human-readable draft with a diff against the current
 * state) from a parsed prompt.
 *
 * plan.ts writes files only. It makes ZERO network calls: a draft must be
 * producible and reviewable before anything touches Flagsmith.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePrompt } from "./parse.js";
import type { ExperimentPlan } from "./types.js";

export const FLAG_NAME = "landing_cta";
export const EXPERIMENT_NAME = "landing-cta-headline-v1";
export const SIMULATION_SEED = 20261126;
export const TRUE_RATES = { control: 0.1, treatment: 0.15 };

export function buildPlan(rawPrompt: string): ExperimentPlan {
  const p = parsePrompt(rawPrompt);
  const total = p.identitiesPerVariant * 2;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    prompt: rawPrompt.trim(),
    flag: {
      name: FLAG_NAME,
      defaultValue: "control",
      variants: [{ key: "treatment", value: "treatment" }],
    },
    metric: {
      name: p.metricName,
      aggregation: "occurrence",
      direction: "up",
      event: p.metricEvent,
    },
    secondaryMetric: {
      name: "cta_click_rate",
      aggregation: "occurrence",
      direction: "up",
      event: "cta_clicked",
    },
    experiment: {
      name: EXPERIMENT_NAME,
      hypothesis: p.hypothesis,
      rolloutPercentage: 100,
      allocation: p.allocation,
    },
    copy: {
      control: { key: "control", ...p.controlCopy },
      treatment: { key: "treatment", ...p.treatmentCopy },
    },
    simulation: {
      identitiesPerVariant: p.identitiesPerVariant,
      totalIdentities: total,
      seed: SIMULATION_SEED,
      trueRates: TRUE_RATES,
    },
    defaultsUsed: p.defaultsUsed,
  };
}

export function planSha256(plan: ExperimentPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function renderSummary(plan: ExperimentPlan): string {
  const lines: string[] = [];
  const { flag, metric, secondaryMetric, experiment, copy, simulation } = plan;
  lines.push(`# 实验草案：${experiment.name}`);
  lines.push("");
  lines.push(`> 由提示词生成（草案，未落地 Flagsmith）。生成时间：${plan.generatedAt}`);
  lines.push(`> 原始提示词：${plan.prompt}`);
  lines.push("");
  lines.push("## 假设");
  lines.push("");
  lines.push(plan.experiment.hypothesis);
  lines.push("");
  lines.push("## 将新建的对象（与现状的 diff）");
  lines.push("");
  lines.push("| 对象 | 名称 | 详情 |");
  lines.push("|---|---|---|");
  lines.push(
    `| Multivariate flag | \`${flag.name}\` | 默认值 \`${flag.defaultValue}\`；变体 \`treatment\`（值 \`treatment\`），control 为 flag 自身保留值 |`,
  );
  lines.push(
    `| Metric（主要） | \`${metric.name}\` | 聚合 \`${metric.aggregation}\`，方向 \`${metric.direction}\`，事件 \`${metric.event}\`（大小写敏感，须与代码 trackEvent 逐字一致） |`,
  );
  lines.push(
    `| Metric（次要，仅观察） | \`${secondaryMetric.name}\` | 事件 \`${secondaryMetric.event}\`，不用于下结论 |`,
  );
  lines.push(
    `| Experiment | \`${experiment.name}\` | 分流 ${experiment.allocation.control}/${experiment.allocation.treatment}，rollout ${experiment.rolloutPercentage}%，建后为 draft、不启动 |`,
  );
  lines.push("");
  lines.push("## 变体文案");
  lines.push("");
  lines.push("| 变体 | 主标题 | CTA |");
  lines.push("|---|---|---|");
  lines.push(`| control | ${copy.control.headline} | ${copy.control.cta} |`);
  lines.push(`| treatment | ${copy.treatment.headline} | ${copy.treatment.cta} |`);
  lines.push("");
  lines.push("## 模拟设定");
  lines.push("");
  lines.push(`- 每组 ${simulation.identitiesPerVariant} 人，共 ${simulation.totalIdentities} 个独立 identity`);
  lines.push(`- 固定种子 PRNG seed=${simulation.seed}，转化掷骰可复现`);
  lines.push(
    `- 模拟真值：control 转化率 ${simulation.trueRates.control * 100}%，treatment ${simulation.trueRates.treatment * 100}%（相对 +50%、绝对 +5pp；效应量取大是为了让教学型样本量内得出明确结论）`,
  );
  lines.push("- 转化概率挂在「实际所见变体」上，不是预先分组；分流不均会如实进入数据");
  lines.push("");
  if (plan.defaultsUsed.length > 0) {
    lines.push("## ⚠️ 解析时用的默认值（请复核）");
    lines.push("");
    lines.push("以下字段提示词里没写明，agent 按设计文档默认值填入。批准前请确认或修改：");
    lines.push("");
    for (const d of plan.defaultsUsed) {
      lines.push(`- **${d.field}**：${d.defaultValue} —— ${d.note}`);
    }
    lines.push("");
  }
  lines.push("## 批准门");
  lines.push("");
  lines.push("- 门 1（建对象前）：人工输入 `approve` 才调用 Flagsmith API 创建 flag / metric / experiment。");
  lines.push("- 门 2（启动前）：实验建好后仍为 draft；启动会锁定 flag，须再次输入 `approve` 才 POST start。");
  lines.push("- 任一门拒绝即停止，草案保留，可修改提示词后重新生成。");
  lines.push("");
  lines.push(`## 草案哈希`);
  lines.push("");
  lines.push(`\`sha256:${planSha256(plan)}\``);
  lines.push("");
  return lines.join("\n");
}

export interface PlanOutputs {
  planPath: string;
  summaryPath: string;
  plan: ExperimentPlan;
}

/** Write experiment-plan.json + plan-summary.md into outDir. Returns paths. */
export function writePlan(rawPrompt: string, outDir: string): PlanOutputs {
  const plan = buildPlan(rawPrompt);
  mkdirSync(outDir, { recursive: true });
  const planPath = join(outDir, "experiment-plan.json");
  const summaryPath = join(outDir, "plan-summary.md");
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(summaryPath, renderSummary(plan));
  return { planPath, summaryPath, plan };
}
