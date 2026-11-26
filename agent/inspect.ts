/**
 * agent/inspect.ts — MCP read-only inspection (cross-check).
 *
 * Tries the Flagsmith hosted MCP server (https://mcp.flagsmith.com, API key
 * as Bearer) over streamable HTTP: initialize -> tools/list -> call one
 * read-only flag/experiment tool if one is discoverable. The MCP server
 * cannot start experiments (official agent guide) — lifecycle stays on
 * CLI/API; MCP is read-only patrol here.
 *
 * If MCP is unreachable from this environment (known failure mode, design.md
 * R2), the script does NOT block the main line: it falls back to direct
 * REST GETs for the same cross-check (flag state + experiment + results)
 * and labels which channel produced each line, so the reader can tell MCP
 * evidence from REST evidence.
 *
 * Usage:
 *   npx tsx agent/inspect.ts [--plan out/experiment-plan.json] [--timeout-ms 15000]
 * Exit 0 = cross-check done (via MCP or via REST fallback); exit 2 = both
 * channels failed.
 */
import { readFileSync } from "node:fs";
import { loadEnvFile } from "./env.js";
import { fetchWithRetry } from "./env.js";
import type { ExperimentPlan } from "./types.js";

const MCP_URL = "https://mcp.flagsmith.com/mcp";
const API = "https://api.flagsmith.com/api/v1";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function mcpCall(
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  id: number,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchWithRetry(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const text = await res.text();
  // Streamable HTTP may return SSE frames; take the last data: line, or the
  // whole body if it is plain JSON.
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  const payload = lines.length > 0 ? lines[lines.length - 1].slice(5).trim() : text.trim();
  const json = JSON.parse(payload) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
  return json.result;
}

async function restGet(path: string, apiKey: string): Promise<unknown> {
  const res = await fetchWithRetry(`${API}${path}`, {
    headers: { Authorization: `Api-Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return await res.json();
}

async function main(): Promise<void> {
  loadEnvFile();
  const planPath = arg("--plan", "out/experiment-plan.json")!;
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as ExperimentPlan;
  const timeoutMs = Number(arg("--timeout-ms", "15000"));
  const apiKey = process.env.FLAGSMITH_API_KEY;
  const envKey = process.env.FLAGSMITH_ENVIRONMENT_KEY;
  const projectId = process.env.FLAGSMITH_PROJECT_ID;
  if (!apiKey || !envKey || !projectId) {
    console.error("缺少 FLAGSMITH_API_KEY / FLAGSMITH_ENVIRONMENT_KEY / FLAGSMITH_PROJECT_ID（写进 .env）。");
    process.exit(2);
  }

  console.log(`巡检：flag=${plan.flag.name} experiment=${plan.experiment.name} metric=${plan.metric.name}`);
  let mcpOk = false;
  try {
    await mcpCall(apiKey, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "prompt-to-experiment-inspect", version: "0.1.0" },
    }, 1, timeoutMs);
    const tools = (await mcpCall(apiKey, "tools/list", {}, 2, timeoutMs)) as { tools: McpTool[] };
    const names = tools.tools.map((t) => t.name);
    console.log(`MCP 通：${names.length} 个工具。`);
    const relevant = names.filter((n) => /flag|experiment|metric/i.test(n));
    console.log(`与 flag/experiment/metric 相关的工具：${relevant.join(", ") || "（无）"}`);
    // Try one read-only call if a plausible list/get tool exists; args are
    // best-effort and a failure here is recorded, not fatal.
    const readTool = names.find((n) => /list.*flag/i.test(n)) ?? names.find((n) => /get.*experiment/i.test(n));
    if (readTool) {
      try {
        const result = await mcpCall(apiKey, "tools/call", {
          name: readTool,
          arguments: { projectId: Number(projectId) },
        }, 3, timeoutMs);
        console.log(`MCP 工具 ${readTool} 调用成功：${JSON.stringify(result).slice(0, 500)}`);
      } catch (e) {
        console.log(`MCP 工具 ${readTool} 调用失败（记录，不阻塞）：${e instanceof Error ? e.message : e}`);
      }
    }
    mcpOk = true;
  } catch (e) {
    console.log(`MCP 不通（记录，不阻塞主线；design.md R2）：${e instanceof Error ? e.message : e}`);
  }

  // REST cross-check (same facts, second channel).
  try {
    const features = (await restGet(`/projects/${projectId}/features/`, apiKey)) as {
      results: { id: number; name: string; type: string; default_enabled: boolean }[];
    };
    const flag = features.results.find((f) => f.name === plan.flag.name);
    console.log(
      `REST 巡检 flag：${flag ? `${flag.name} id=${flag.id} type=${flag.type} enabled=${flag.default_enabled}` : `${plan.flag.name} 不存在（尚未创建）`}`,
    );
    const experiments = (await restGet(`/environments/${envKey}/experiments/`, apiKey)) as {
      results: { id: number; name: string; status?: string }[];
    };
    const exp = experiments.results.find((x) => x.name === plan.experiment.name);
    console.log(
      `REST 巡检 experiment：${exp ? `${exp.name} id=${exp.id} status=${exp.status ?? "?"}` : `${plan.experiment.name} 不存在（尚未创建）`}`,
    );
    const metrics = (await restGet(`/environments/${envKey}/experiment-metrics/`, apiKey)) as {
      results: { id: number; name: string }[];
    };
    const metric = metrics.results.find((m) => m.name === plan.metric.name);
    console.log(
      `REST 巡检 metric：${metric ? `${metric.name} id=${metric.id}` : `${plan.metric.name} 不存在（尚未创建）`}`,
    );
  } catch (e) {
    console.error(`REST 巡检也失败：${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  console.log(mcpOk ? "巡检完成（MCP + REST 双通道）。" : "巡检完成（仅 REST 通道；MCP 不通，已记录）。");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
