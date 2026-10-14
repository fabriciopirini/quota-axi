import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandInvocation, findCommandPath } from "../lib/process.js";

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
const OUTPUT_LIMIT_BYTES = 1_048_576;
const CHILD_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);
const WINDOWS_CHILD_ENVIRONMENT_KEYS = new Set([
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
]);

type ClaudeSwapWindow = {
  pct: number;
  resetsAt: string;
};

type ClaudeSwapUsage = {
  fiveHour?: ClaudeSwapWindow;
  sevenDay?: ClaudeSwapWindow;
};

export type ClaudeSwapAccount = {
  accountKey: string;
  email: string;
  organization?: string;
  /** claude-swap's own `usageStatus`; only `ok` carries `usage`. */
  usageStatus: string;
  /** The `usage` object as printed. */
  usage?: ClaudeSwapUsage;
  /** When claude-swap measured `usage`. */
  fetchedAt?: string;
};

export function claudeSwapEnabled(env = process.env): boolean {
  const value = env[CLAUDE_SWAP_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * The accounts `cswap list --json` (schema 1) reports, in its order. Throws
 * when the command is missing, fails, or prints anything but schema 1 with
 * valid, uniquely keyed account rows.
 */
export async function readClaudeSwapAccounts(): Promise<ClaudeSwapAccount[]> {
  const payload = objectValue(JSON.parse(await runCswapList()));
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.accounts))
    throw new Error("claude_swap_malformed");
  const keys = new Set<string>();
  const accounts = payload.accounts.map((raw): ClaudeSwapAccount => {
    const row = objectValue(raw);
    if (!row) throw new Error("claude_swap_malformed");
    const email = requiredString(row.email);
    const organizationUuid = stringIncludingEmpty(row.organizationUuid);
    const organization = optionalString(row, "organizationName");
    const usageStatus = requiredString(row.usageStatus);
    if (!Object.hasOwn(row, "usage")) throw new Error("claude_swap_malformed");
    const usage = parseUsage(row.usage);
    const fetchedAt = optionalDate(row, "usageFetchedAt");
    if (usage && !fetchedAt) throw new Error("claude_swap_malformed");
    const accountKey = `claude-swap:${createHash("sha256")
      .update(JSON.stringify([email, organizationUuid]))
      .digest("hex")
      .slice(0, 24)}`;
    if (keys.has(accountKey)) throw new Error("claude_swap_malformed");
    keys.add(accountKey);
    return {
      accountKey,
      email,
      ...(organization !== undefined ? { organization } : {}),
      usageStatus,
      ...(usage ? { usage } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
    };
  });
  if (accounts.length === 0) throw new Error("claude_swap_malformed");
  return accounts;
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
  const childEnvironment = claudeSwapEnvironment();
  let invocation: ReturnType<typeof commandInvocation>;
  try {
    invocation = commandInvocation(executable, [...ARGS], childEnvironment);
  } catch {
    throw new Error("claude_swap_spawn_failed");
  }
  let outputDirectory: string;
  try {
    outputDirectory = await mkdtemp(join(tmpdir(), "quota-axi-cswap-"));
  } catch {
    throw new Error("claude_swap_unavailable");
  }
  const outputPath = join(outputDirectory, "stdout");
  let outputFd: number;
  try {
    outputFd = openSync(outputPath, "wx", 0o600);
  } catch {
    await removeOutput(outputDirectory);
    throw new Error("claude_swap_unavailable");
  }
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", outputFd, "ignore"],
      detached: true,
      env: invocation.environment ?? childEnvironment,
    });
  } catch {
    closeSync(outputFd);
    await removeOutput(outputDirectory);
    throw new Error("claude_swap_spawn_failed");
  }
  closeSync(outputFd);
  return new Promise((resolve, reject) => {
    let settled = false;
    const walkAway = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      reject(new Error(error));
    };
    const timer = setTimeout(() => walkAway("claude_swap_timed_out"), WAIT_MS);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void removeOutput(outputDirectory).then(() =>
        reject(new Error("claude_swap_spawn_failed")),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void readCompletedOutput(outputPath, outputDirectory, code).then(
        resolve,
        reject,
      );
    });
  });
}

function claudeSwapEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const windows = process.platform === "win32";
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const comparedKey = windows ? key.toUpperCase() : key;
    if (
      CHILD_ENVIRONMENT_KEYS.has(comparedKey) ||
      comparedKey.startsWith("LC_") ||
      (windows && WINDOWS_CHILD_ENVIRONMENT_KEYS.has(comparedKey))
    ) {
      environment[key] = value;
    }
  }
  return environment;
}

async function readCompletedOutput(
  outputPath: string,
  outputDirectory: string,
  exitCode: number | null,
): Promise<string> {
  try {
    if (exitCode !== 0) throw new Error("claude_swap_exit_status");
    if ((await stat(outputPath)).size > OUTPUT_LIMIT_BYTES)
      throw new Error("claude_swap_output_too_large");
    return await readFile(outputPath, "utf8");
  } finally {
    await removeOutput(outputDirectory);
  }
}

async function removeOutput(outputDirectory: string): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

function parseUsage(value: unknown): ClaudeSwapUsage | undefined {
  if (value === null) return undefined;
  const usage = objectValue(value);
  if (!usage) throw new Error("claude_swap_malformed");
  const fiveHour = optionalWindow(usage, "fiveHour");
  const sevenDay = optionalWindow(usage, "sevenDay");
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

function optionalWindow(
  usage: Record<string, unknown>,
  key: string,
): ClaudeSwapWindow | undefined {
  if (!Object.hasOwn(usage, key)) return undefined;
  const value = objectValue(usage[key]);
  if (!value || !Number.isFinite(value.pct) || !validDate(value.resetsAt))
    throw new Error("claude_swap_malformed");
  return { pct: value.pct as number, resetsAt: value.resetsAt as string };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("claude_swap_malformed");
  return value;
}

function stringIncludingEmpty(value: unknown): string {
  if (typeof value !== "string") throw new Error("claude_swap_malformed");
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(row, key)) return undefined;
  return stringIncludingEmpty(row[key]);
}

function optionalDate(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(row, key)) return undefined;
  const value = row[key];
  if (!validDate(value)) throw new Error("claude_swap_malformed");
  return value;
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    Number.isFinite(Date.parse(value))
  );
}
