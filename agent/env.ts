/**
 * agent/env.ts — minimal .env loader shared by the agent scripts.
 * Only sets vars not already set; never prints values.
 */
import { readFileSync } from "node:fs";

export function loadEnvFile(path = ".env"): void {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // No .env — callers fail loudly when they need a credential.
  }
}

/**
 * fetch with retries on transport errors. The egress proxy intermittently
 * resets the first request on a connection ("other side closed"); a retry
 * on a fresh connection normally succeeds. Only network errors are
 * retried — HTTP error statuses are returned as-is for the caller to judge.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastError;
}
