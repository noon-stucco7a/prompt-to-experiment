// 一次性探针：验证 Node SDK 只读路径（init + identify + getExperimentFlag）。
// 用法：node scripts/sdk-smoke.mjs
import { createFlagsmithInstance } from "@flagsmith/flagsmith/isomorphic";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env", "utf-8").split("\n").filter(Boolean).map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1)];
}));
const fs = createFlagsmithInstance();
const retryFetch = async (url, opts) => {
  for (let i = 0; i < 3; i++) {
    try { return await fetch(url, opts); }
    catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
};
await fs.init({ environmentID: env.FLAGSMITH_ENVIRONMENT_KEY, enableEvents: true, fetch: retryFetch });
for (const id of ["smoke-user-a", "smoke-user-b"]) {
  await fs.identify(id);
  const demo = fs.getExperimentFlag("show_demo_button");
  const cta = fs.getExperimentFlag("landing_cta");
  console.log(id, "| show_demo_button:", demo ? JSON.stringify({ enabled: demo.enabled, value: demo.value, variant: demo.variant }) : "null",
    "| landing_cta:", cta ? JSON.stringify(cta) : "null（flag 不存在）");
}
await Promise.race([fs.flushEvents(), new Promise((r) => setTimeout(r, 10000))]);
console.log("SDK smoke done");
