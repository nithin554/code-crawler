import os from "node:os";
import path from "node:path";

/**
 * Global configuration for code-crawler.
 *
 * All values can be overridden via environment variables so MCP clients can
 * point the server at different databases without code changes.
 */

const DEFAULT_DB_PATH = path.join(os.homedir(), ".code-crawler", "index.db");

function warn(message: string): void {
  process.stderr.write(`code-crawler: ${message}\n`);
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  warn(`${name}="${raw}" is not a boolean (use true/false); using ${fallback}`);
  return fallback;
}

/** Parse an integer, clamping out-of-range values and warning about both. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warn(`${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  const truncated = Math.trunc(parsed);
  if (truncated < min || truncated > max) {
    const clamped = Math.min(max, Math.max(min, truncated));
    warn(`${name}="${raw}" must be between ${min} and ${max}; using ${clamped}`);
    return clamped;
  }
  return truncated;
}

export interface Config {
  /** Path to the SQLite property-graph database. */
  dbPath: string;
  /** Directory names excluded during crawling. */
  excludeDirs: string[];
  /** Default number of results for list-returning tools. */
  defaultLimit: number;
  /** Cap on transitive traversal depth to keep queries bounded. */
  maxDepth: number;
  /** Files larger than this are skipped instead of parsed. */
  maxFileBytes: number;
  /** Honor the project's .gitignore when discovering source files. */
  respectGitignore: boolean;
  /** When true, errors include symbol-search suggestions. */
  helpfulErrors: boolean;
}

export function loadConfig(): Config {
  return {
    dbPath: envStr("CODECRAWLER_DB", DEFAULT_DB_PATH),
    excludeDirs: [
      ...new Set(
        envStr(
          "CODECRAWLER_EXCLUDE_DIRS",
          ".git,node_modules,dist,build,target,.idea,.venv,.gradle,out,.next,coverage"
        )
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      ),
    ],
    defaultLimit: envInt("CODECRAWLER_DEFAULT_LIMIT", 50, 1, 5000),
    maxDepth: envInt("CODECRAWLER_MAX_DEPTH", 10, 1, 100),
    maxFileBytes: envInt("CODECRAWLER_MAX_FILE_BYTES", 1_000_000, 1024, 64 * 1024 * 1024),
    respectGitignore: envBool("CODECRAWLER_RESPECT_GITIGNORE", true),
    helpfulErrors: envBool("CODECRAWLER_HELPFUL_ERRORS", true),
  };
}
