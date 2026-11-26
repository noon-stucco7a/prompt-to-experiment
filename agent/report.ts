/**
 * agent/report.ts — pull platform experiment results + independent z-test.
 *
 * Reads `GET /api/v1/environments/<env-key>/experiments/<id>/results/`
 * (Flagsmith Bayesian engine: lift, 95% credible interval, probability to
 * beat control) and cross-checks it with a self-computed two-proportion
 * z-test (pooled) on the exported per-variant counts. Writes report.md.
 * When the platform and the z-test disagree, the platform wins and the
 * disagreement is stated in the report (design.md §2.4).
 *
 * The results payload shape is read defensively: per-variant counts are
 * searched under common field names and the raw payload keys are echoed
 * into the report, so an unexpected shape is visible instead of silently
 * producing a wrong conclusion.
 *
 * Usage:
 *   npx tsx agent/report.ts [--plan out/experiment-plan.json]
 *       [--experiment-id 12] [--out out/report.md]
 * Without --experiment-id the experiment is resolved by name from the plan.
 * Exits 1 (after still writing the draft) when results are not available
 * yet — an empty results page is a fact to report, not a silent success.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "./env.js";
import { fetchWithRetry } from "./env.js";
import type { ExperimentPlan } from "./types.js";

const API = "https://api.flagsmith.com/api/v1";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetchWithRetry(`${API}${path}`, {
    headers: { Authorization: `Api-Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Normal CDF (Abramowitz & Stegun 7.1.26). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

interface VariantCounts {
  key: string;
  exposures: number;
  conversions: number;
}

function zTest(a: VariantCounts, b: VariantCounts): {
  pA: number;
  pB: number;
  diff: number;
  se: number;
  z: number;
  pValue: number;
  ciLow: number;
  ciHigh: number;
} {
  const pA = a.conversions / a.exposures;
  const pB = b.conversions / b.exposures;
  const pooled =
    (a.conversions + b.conversions) / (a.exposures + b.exposures);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.exposures + 1 / b.exposures));
  const diff = pB - pA;
  const z = se === 0 ? 0 : diff / se;
  const pValue = 2 * (1 - normCdf(Math.abs(z)));
  return { pA, pB, diff, se, z, pValue, ciLow: diff - 1.96 * se, ciHigh: diff + 1.96 * se };
}

/** Best-effort extraction of per-variant exposures/conversions. */
function extractCounts(results: unknown): VariantCounts[] | null {
  const out: VariantCounts[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const o = node as Record<string, unknown>;
    // Flagsmith 实际载荷形态：payload.metrics[].variants = { control: { n, sum }, treatment: { n, sum } }
    // n = exposure 数，sum = 事件发生数（occurrence 聚合下即转化数）。
    if (o.variants && typeof o.variants === "object" && !Array.isArray(o.variants)) {
      for (const [key, v] of Object.entries(o.variants as Record<string, unknown>)) {
        if (v && typeof v === "object") {
          const vv = v as Record<string, unknown>;
          if (typeof vv.n === "number" && typeof vv.sum === "number") {
            out.push({ key, exposures: vv.n, conversions: vv.sum });
          }
        }
      }
      if (out.length > 0) return;
    }
    const key =
      (typeof o.variant === "string" && o.variant) ||
      (typeof o.key === "string" && o.key) ||
      (typeof o.name === "string" && o.name) ||
      (typeof o.variant_key === "string" && o.variant_key);
    const exposures =
      (typeof o.exposures === "number" && o.exposures) ||
      (typeof o.participants === "number" && o.participants) ||
      (typeof o.users === "number" && o.users);
    const conversions =
      (typeof o.conversions === "number" && o.conversions) ||
      (typeof o.events === "number" && o.events) ||
      (typeof o.successes === "number" && o.successes);
    if (key && typeof exposures === "number" && typeof conversions === "number") {
      out.push({ key, exposures, conversions });
      return;
    }
    Object.values(o).forEach(visit);
  };
  visit(results);
  // De-duplicate by key, keep the first hit per key.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

async function main(): Promise<void> {
  loadEnvFile();
  const planPath = arg("--plan", "out/experiment-plan.json")!;
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as ExperimentPlan;
  const outPath = arg("--out", "out/report.md")!;
  const apiKey = process.env.FLAGSMITH_API_KEY;
  const envKey = process.env.FLAGSMITH_ENVIRONMENT_KEY;
  if (!apiKey || !envKey) {
    console.error("缺少 FLAGSMITH_API_KEY 或 FLAGSMITH_ENVIRONMENT_KEY（写进 .env）。");
    process.exit(2);
  }

  let experimentId = arg("--experiment-id");
  let experimentName = plan.experiment.name;
  if (!experimentId) {
    const list = await apiGet<{ results: { id: number; name: string; status?: string }[] }>(
      `/environments/${envKey}/experiments/`,
      apiKey,
    );
    const found = list.results.find((e) => e.name === experimentName);
    if (!found) {
      const draft = [
        `# 实验结论报告（草稿）：${experimentName}`,
        ``,
        `> 状态：实验尚未在 Flagsmith 中创建（按名查找无结果），无平台结论可拉取。`,
        `> 本文件为占位草稿，待 experiment 建成并跑满样本量后由 report.ts 重写。`,
        ``,
        `- 假设：${plan.experiment.hypothesis}`,
        `- 主要指标：${plan.metric.name}（事件 \`${plan.metric.event}\`，occurrence，方向 up）`,
        `- 分流：control / treatment 各 50%，rollout ${plan.experiment.rolloutPercentage}%`,
        `- 计划样本量：每组 ${plan.simulation.identitiesPerVariant} 人，共 ${plan.simulation.totalIdentities} 人`,
      ].join("\n");
      writeFileSync(outPath, draft + "\n");
      console.log(`实验未找到，已写占位草稿：${outPath}`);
      process.exit(1);
    }
    experimentId = String(found.id);
  }

  const results = await apiGet<unknown>(
    `/environments/${envKey}/experiments/${experimentId}/results/`,
    apiKey,
  );
  const counts = extractCounts(results);
  const smoke = process.argv.includes("--smoke");
  const generatedAt = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# 实验结论报告：${experimentName}`);
  lines.push(``);
  if (smoke) {
    lines.push(`> ⚠️ 冒烟数据：本报告基于 50 人冒烟流量（+2 个 SDK 探针身份），非正式结论。`);
    lines.push(`> 正式结论以跑满 2,000 人（每组 1,000 人）后的报告为准；50 人样本下贝叶斯推断与 z 检验均无统计效力。`);
    lines.push(``);
  }
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 实验 ID：${experimentId}`);
  lines.push(`- 假设：${plan.experiment.hypothesis}`);
  lines.push(`- 主要指标：${plan.metric.name}（事件 \`${plan.metric.event}\`，occurrence，方向 up）`);
  lines.push(``);
  lines.push(`## 平台结论（Flagsmith 贝叶斯引擎）`);
  lines.push(``);
  lines.push("```json");
  lines.push(JSON.stringify(results, null, 2));
  lines.push("```");
  lines.push(``);

  if (!counts || counts.length < 2) {
    lines.push(`## 自算 z 检验`);
    lines.push(``);
    lines.push(
      `> 暂无可用的分组计数（results 载荷中未解析出两组的 exposures/conversions），无法自算 z 检验。` +
        `可能原因：实验刚启动、results 尚未刷新（每 5 分钟最多刷新一次），或载荷结构与预期不同（原始 JSON 见上）。`,
    );
    writeFileSync(outPath, lines.join("\n") + "\n");
    console.log(`已写报告（仅平台原始结论，无自算检验）：${outPath}`);
    process.exit(1);
  }

  const control = counts.find((c) => c.key === "control") ?? counts[0];
  const treatment = counts.find((c) => c.key !== control.key) ?? counts[1];
  const t = zTest(control, treatment);
  const pct = (x: number) => (x * 100).toFixed(2) + "%";
  lines.push(`## 自算交叉验证（双比例 z 检验，pooled）`);
  lines.push(``);
  lines.push(`| 组 | exposure | 转化 | 转化率 |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| control | ${control.exposures} | ${control.conversions} | ${pct(t.pA)} |`);
  lines.push(`| treatment | ${treatment.exposures} | ${treatment.conversions} | ${pct(t.pB)} |`);
  lines.push(``);
  lines.push(`- 转化率差（treatment − control）：${pct(t.diff)}，95% CI [${pct(t.ciLow)}, ${pct(t.ciHigh)}]`);
  lines.push(`- z = ${t.z.toFixed(3)}，双侧 p = ${t.pValue.toExponential(3)}`);
  lines.push(``);
  lines.push(`## 结论`);
  lines.push(``);
  const significant = t.pValue < 0.05;
  lines.push(
    significant
      ? `在 α=0.05 下差异显著（p=${t.pValue.toExponential(2)}）。treatment 转化率${t.diff >= 0 ? "高于" : "低于"} control ${pct(Math.abs(t.diff))}。` +
          `若平台贝叶斯胜出概率 ≥95% 且方向一致，建议全量 treatment；否则以平台结论为准并注明分歧。`
      : `在 α=0.05 下差异不显著（p=${t.pValue.toFixed(3)}）。无差异也是有效结论：不建议据此全量，` +
          `建议延长实验或检查效应量假设。`,
  );
  lines.push(``);
  lines.push(`## 局限`);
  lines.push(``);
  lines.push(`- 只看主要指标 \`${plan.metric.name}\` 下结论；次要指标 \`${plan.secondaryMetric.name}\` 仅观察。`);
  lines.push(`- 流量为模拟流量（种子 PRNG，真值 control ${plan.simulation.trueRates.control * 100}% / treatment ${plan.simulation.trueRates.treatment * 100}%），结论反映模拟设定下的效应，见 README 统计口径。`);
  lines.push(`- 平台结论与自算检验不一致时，以平台为准并注明。`);

  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`报告已写：${outPath}（z=${t.z.toFixed(3)}，p=${t.pValue.toExponential(3)}）`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
