#!/usr/bin/env tsx
/**
 * agent CLI:
 *   npm run plan -- "测一下收益型标题对注册转化率的影响" [--out out]
 *   npm run approve -- --gate gate-1 --plan out/experiment-plan.json [--summary out/plan-summary.md]
 *   npm run apply -- --plan out/experiment-plan.json [--dry-run] [--project 55963]
 *
 * The two approval gates are separate processes on purpose: gate 1 must be
 * passed by a human typing `approve` before apply runs, and gate 2 (start)
 * is a separate invocation before any start call is made.
 */

import { readFileSync } from "node:fs";
import { approvalGate } from "./approve.js";
import { applyPlan, loadPlan } from "./apply.js";
import { writePlan } from "./plan.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function loadEnvFile(): void {
  // Minimal .env loader (no dependency): only sets vars not already set.
  try {
    for (const line of readFileSync(".env", "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // No .env yet — commands that need credentials will fail loudly.
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const cmd = process.argv[2];

  if (cmd === "plan") {
    const prompt = process.argv[3] ?? (arg("--prompt-file") ? readFileSync(arg("--prompt-file")!, "utf-8") : "");
    if (!prompt.trim()) {
      console.error('用法：npm run plan -- "提示词" [--out out]');
      process.exit(2);
    }
    const outDir = arg("--out", "out")!;
    const { planPath, summaryPath, plan } = writePlan(prompt, outDir);
    console.log(`草案已生成（未调用任何 API）：`);
    console.log(`  plan:    ${planPath}`);
    console.log(`  summary: ${summaryPath}`);
    console.log(`  默认值：${plan.defaultsUsed.length} 项（见 plan-summary.md 的「⚠️ 解析时用的默认值」）`);
    console.log(`\n下一步：人工读 plan-summary.md，然后跑批准门 1：`);
    console.log(`  npm run approve -- --gate gate-1 --plan ${planPath} --summary ${summaryPath}`);
    return;
  }

  if (cmd === "approve") {
    const gate = arg("--gate");
    const planPath = arg("--plan");
    if (!gate || !planPath) {
      console.error("用法：npm run approve -- --gate gate-1|gate-2 --plan out/experiment-plan.json [--summary out/plan-summary.md]");
      process.exit(2);
    }
    const ok = await approvalGate({ gate, planPath, summaryPath: arg("--summary") });
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "apply") {
    const planPath = arg("--plan");
    if (!planPath) {
      console.error("用法：npm run apply -- --plan out/experiment-plan.json [--dry-run] [--project 55963]");
      process.exit(2);
    }
    const dryRun = flag("--dry-run");
    const environmentKey = process.env.FLAGSMITH_ENVIRONMENT_KEY;
    if (!dryRun && !environmentKey) {
      console.error("缺少 FLAGSMITH_ENVIRONMENT_KEY（写进 .env，见 .env.example）。先跑 --dry-run 检查命令。");
      process.exit(2);
    }
    const plan = loadPlan(planPath);
    applyPlan(plan, { planPath, project: arg("--project"), environmentKey, dryRun });
    if (dryRun) {
      console.log("\n--dry-run 结束：未执行任何命令。确认无误后，先过批准门 1 再真实执行。");
    }
    return;
  }

  console.error("用法：plan | approve | apply（见 README）");
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
