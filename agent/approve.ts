/**
 * approve.ts — the human-in-the-loop approval gate.
 *
 * The gate prints the plan summary and the sha256 of the plan file, then
 * waits for a human to type exactly `approve` on stdin. Anything else
 * (including EOF / Ctrl-C / an empty line) rejects and the process exits
 * non-zero.
 *
 * Design guarantees:
 *  - This module imports nothing network-capable. Approving nothing means
 *    zero API calls: the gate itself cannot call Flagsmith even by accident.
 *  - Gate 1 (create objects) and gate 2 (start the experiment) are
 *    independent invocations; each requires its own explicit `approve`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";

export interface GateOptions {
  /** "gate-1" (create flag/metric/experiment) or "gate-2" (start). */
  gate: string;
  /** Path to the experiment-plan.json this gate is approving. */
  planPath: string;
  /** Path to the human-readable plan-summary.md (printed for review). */
  summaryPath?: string;
  /** Input stream; defaults to process.stdin (injectable for tests). */
  input?: Readable;
  /** Output stream; defaults to process.stdout. */
  output?: NodeJS.WritableStream;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const GATE_DESCRIPTIONS: Record<string, string> = {
  "gate-1":
    "创建 Flagsmith 对象：multivariate flag、metric、experiment（建后为 draft，不启动）。",
  "gate-2":
    "启动实验：POST start。启动会锁定 flag 并打开分流，之后 flag 不可再改。",
};

export async function approvalGate(opts: GateOptions): Promise<boolean> {
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const write = (s: string) => out.write(s);

  write(`\n===== 批准门 ${opts.gate} =====\n`);
  write(`${GATE_DESCRIPTIONS[opts.gate] ?? "人工批准门。"}\n\n`);
  write(`草案文件：${opts.planPath}\n`);
  write(`sha256：${sha256File(opts.planPath)}\n\n`);

  if (opts.summaryPath) {
    try {
      write(readFileSync(opts.summaryPath, "utf-8"));
      write("\n");
    } catch {
      write(`（读不到摘要文件 ${opts.summaryPath}，请先检查草案。）\n`);
    }
  }

  write(`输入 approve 放行，其他任意输入均拒绝：\n> `);
  // Read the first line from stdin, resolving on the first newline OR on
  // EOF — whichever comes first. (node:readline's "close" can win the race
  // against "line" when stdin is an already-ended pipe, which would swallow
  // a piped `approve`; reading the stream directly avoids that.)
  const answer = await new Promise<string>((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    input.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl).trim());
    });
    input.on("end", () => finish(buf.split(/\r?\n/)[0].trim()));
    input.on("error", () => finish(""));
  });

  if (answer === "approve") {
    write(`\n批准门 ${opts.gate}：已批准。\n`);
    return true;
  }
  write(`\n批准门 ${opts.gate}：未批准（输入为 ${JSON.stringify(answer)}），停止。草案已保留。\n`);
  return false;
}
