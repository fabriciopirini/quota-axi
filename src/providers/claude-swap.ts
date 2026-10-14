import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { findCommandPath } from "../lib/process.js";

/**
 * Opt-in: report one Claude lane per account claude-swap manages, read from
 * the JSON its own `cswap list --json` prints. quota-axi receives usage and
 * account labels only; claude-swap keeps every credential it manages.
 */
const CLAUDE_SWAP_ENV = "QUOTA_AXI_CLAUDE_SWAP";
export const CLAUDE_SWAP_SOURCE = "claude-swap";

const COMMAND = "cswap";
const ARGS = ["list", "--json"] as const;
/** claude-swap 0.26 bounds each usage fetch at 5s and a token refresh at 10s. */
const WAIT_MS = 30_000;
const OUTPUT_LIMIT_CHARS = 1_048_576;

export type ClaudeSwapAccount = {
  accountKey: string;
  email: string;
  organization?: string;
  /** claude-swap's own `usageStatus`; only `ok` carries `usage`. */
  usageStatus: string;
  /** The `usage` object as printed: `fiveHour`, `sevenDay`, `scoped`. */
  usage?: Record<string, unknown>;
  /** When claude-swap measured `usage`. */
  fetchedAt?: string;
};

export function claudeSwapEnabled(env = process.env): boolean {
  const value = env[CLAUDE_SWAP_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * The accounts `cswap list --json` (schema 1) reports, in its order. Throws
 * when the command is missing, fails, or prints anything but schema 1, so
 * the collector falls back to Claude's single selected lane. A row without an
 * email cannot be keyed and is left out.
 */
export async function readClaudeSwapAccounts(): Promise<ClaudeSwapAccount[]> {
  const payload = objectValue(JSON.parse(await runCswapList()));
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.accounts))
    throw new Error("claude_swap_malformed");
  return payload.accounts.flatMap((raw): ClaudeSwapAccount[] => {
    const row = objectValue(raw);
    const email = stringValue(row?.email);
    if (!row || !email) return [];
    const organizationUuid = stringValue(row.organizationUuid) ?? "";
    return [
      {
        accountKey: `claude-swap:${createHash("sha256")
          .update(JSON.stringify([email, organizationUuid]))
          .digest("hex")
          .slice(0, 24)}`,
        email,
        organization: stringValue(row.organizationName),
        usageStatus: stringValue(row.usageStatus) ?? "unavailable",
        usage: objectValue(row.usage),
        fetchedAt: stringValue(row.usageFetchedAt),
      },
    ];
  });
}

/**
 * `cswap list --json` may renew a credential claude-swap manages while it
 * fetches usage, so a slow run is waited out and then left running, never
 * signalled: killing it mid-exchange could leave its store holding a spent
 * refresh token. It gets no stdin and its own process group, like a delegate.
 */
async function runCswapList(): Promise<string> {
  const executable = await findCommandPath(COMMAND);
  if (!executable) throw new Error("claude_swap_unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...ARGS], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let output = "";
    const walkAway = (error: string) => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.unref();
      reject(new Error(error));
    };
    const timer = setTimeout(() => walkAway("claude_swap_timed_out"), WAIT_MS);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > OUTPUT_LIMIT_CHARS)
        walkAway("claude_swap_output_too_large");
    });
    child.on("error", () => walkAway("claude_swap_spawn_failed"));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error("claude_swap_exit_status"));
    });
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
