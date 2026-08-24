import path from "node:path";
import os from "node:os";

/**
 * Global configuration for code-crawler.
 *
 * All values can be overridden via environment variables so MCP clients can
 * point the server at different databases without code changes.
 */

const DEFAULT_DB_PATH = path.join(os.homedir(), ".code-crawler", "index.db");

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
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
  /** When true, errors include symbol-search suggestions. */
  helpfulErrors: boolean;
}

export function loadConfig(): Config {
  return {
    dbPath: envStr("CODECRAWLER_DB", DEFAULT_DB_PATH),
    excludeDirs: envStr(
      "CODECRAWLER_EXCLUDE_DIRS",
      ".git,node_modules,dist,build,target,.idea,.venv,.gradle,out,.next,coverage"
    )
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    defaultLimit: Number(envStr("CODECRAWLER_DEFAULT_LIMIT", "50")),
    maxDepth: Number(envStr("CODECRAWLER_MAX_DEPTH", "10")),
    helpfulErrors: envBool("CODECRAWLER_HELPFUL_ERRORS", true),
  };
}
