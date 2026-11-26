/**
 * sim/simulate.ts — replay simulated traffic against the experiment flag.
 *
 * Method (design.md §2.5): for each simulated identity, identify with the
 * Node SDK, evaluate `getExperimentFlag('landing_cta')` (this records the
 * exposure), read the variant ACTUALLY assigned, and roll the dice against
 * THAT variant's true conversion rate. Conversion probability is therefore
 * attached to the variant seen, not to a pre-assigned group — bucketing
 * skew shows up in the data exactly as in a real experiment.
 *
 * Deterministic dice: mulberry32 PRNG, seed from the plan (20261126).
 * Bucketing is Flagsmith's (deterministic identity hash), so a whole run
 * is reproducible given the same plan + seed + identity naming.
 *
 * Usage:
 *   npx tsx sim/simulate.ts [--plan out/experiment-plan.json] [--total 50]
 *       [--prefix sim-user] [--out out/sim-50.json]
 * Default --total is the plan's totalIdentities (2000); pass --total 50 for
 * the smoke run. Exits non-zero if exposures != total (reconciliation fail).
 * Flush is bounded by a timeout so a stalled events pipeline cannot hang
 * the run forever — a flush timeout is reported, not hidden.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createFlagsmithInstance } from "@flagsmith/flagsmith/isomorphic";
import { loadEnvFile, fetchWithRetry } from "../agent/env.js";
import type { ExperimentPlan } from "../agent/types.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

async function flushWithTimeout(
  fs: { flushEvents: () => Promise<void> },
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fs.flushEvents(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]).then((v) => {
      if (v === "timeout") throw new Error("flush-timeout");
    });
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const planPath = arg("--plan", "out/experiment-plan.json")!;
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as ExperimentPlan;
  const total = Number(arg("--total", String(plan.simulation.totalIdentities)));
  const prefix = arg("--prefix", "sim-user")!;
  const outPath = arg("--out", `out/sim-${total}.json`)!;
  const envKey = process.env.FLAGSMITH_ENVIRONMENT_KEY;
  if (!envKey) {
    console.error("缺少 FLAGSMITH_ENVIRONMENT_KEY（写进 .env）。");
    process.exit(2);
  }
  if (!Number.isInteger(total) || total <= 0) {
    console.error(`--total 必须是正整数，得到 ${arg("--total")}`);
    process.exit(2);
  }

  const rng = mulberry32(plan.simulation.seed);
  const flagName = plan.flag.name;
  const primaryEvent = plan.metric.event;
  const trueRates = plan.simulation.trueRates;

  const fs = createFlagsmithInstance();
  // NOTE: pass a retrying fetch explicitly. The SDK's bundled default fetch
  // ignores NODE_USE_ENV_PROXY and tries a direct connection, which this
  // sandbox blocks ("fetch failed"); the global fetch honours the proxy.
  // Retries cover the proxy intermittently resetting the first request on
  // a connection ("other side closed").
  await fs.init({
    environmentID: envKey,
    enableEvents: true,
    fetch: (url: string, init?: RequestInit) => fetchWithRetry(url, init),
  });
  console.log(
    `模拟开始：flag=${flagName} 事件=${primaryEvent} 总人数=${total} seed=${plan.simulation.seed} 前缀=${prefix}`,
  );

  // Preflight: abort before identifying anyone if the flag does not exist
  // yet (avoids creating stray identities on a misconfigured run).
  const probe = fs.getValue(flagName);
  if (probe === null || probe === undefined) {
    console.error(
      `flag \`${flagName}\` 在环境中不存在（getValue 返回 null）。请先跑 apply 创建 flag/metric/experiment，0 人已处理。`,
    );
    process.exit(1);
  }

  const counts: Record<string, { exposures: number; conversions: number }> = {};
  for (const key of Object.keys(trueRates)) counts[key] = { exposures: 0, conversions: 0 };
  let unknownVariant = 0;

  for (let i = 1; i <= total; i++) {
    const identity = `${prefix}-${String(i).padStart(4, "0")}`;
    await fs.identify(identity);
    const flag = fs.getExperimentFlag(flagName);
    if (!flag) {
      console.error(
        `第 ${i} 人 (${identity})：flag \`${flagName}\` 读不到（null）。实验可能尚未创建/启动，或 flag 名有误。已处理 ${i - 1} 人，停止。`,
      );
      process.exit(1);
    }
    // Variant actually assigned: multivariate variant key, else the flag's
    // own value (control). Never pre-assign groups.
    const variant = flag.variant === "treatment" ? "treatment" : "control";
    if (!counts[variant]) {
      counts[variant] = { exposures: 0, conversions: 0 };
      unknownVariant++;
    }
    counts[variant].exposures++;
    const p = trueRates[variant] ?? 0;
    if (rng() < p) {
      fs.trackEvent(primaryEvent);
      counts[variant].conversions++;
    }
    if (i % 50 === 0 || i === total) {
      const done = Object.entries(counts)
        .map(([k, c]) => `${k} ${c.exposures}人/${c.conversions}转`)
        .join("，");
      console.log(`进度 ${i}/${total}：${done}`);
    }
  }

  const flushed = await flushWithTimeout(fs, 30_000);
  console.log(flushed ? "事件已 flush。" : "警告：flush 30 秒超时，尾部事件可能未送达（见 design.md R5）。");

  const totalExposures = Object.values(counts).reduce((s, c) => s + c.exposures, 0);
  const totalConversions = Object.values(counts).reduce((s, c) => s + c.conversions, 0);
  const summary = {
    plan: planPath,
    seed: plan.simulation.seed,
    total,
    prefix,
    flag: flagName,
    event: primaryEvent,
    trueRates,
    counts,
    totalExposures,
    totalConversions,
    flushed,
    reconciled: totalExposures === total,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\n对账：exposure=${totalExposures}/${total}，转化事件=${totalConversions}，写入 ${outPath}`);
  for (const [k, c] of Object.entries(counts)) {
    const rate = c.exposures ? ((c.conversions / c.exposures) * 100).toFixed(1) : "—";
    console.log(`  ${k}：${c.exposures} 人，${c.conversions} 转化，${rate}%（真值 ${(trueRates[k] * 100).toFixed(0)}%）`);
  }
  if (unknownVariant > 0) console.log(`注意：出现 ${unknownVariant} 个计划外变体值，均按 control 计（见上）。`);
  if (totalExposures !== total) {
    console.error("对账失败：exposure 数 ≠ 总人数。");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
