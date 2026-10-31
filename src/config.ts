import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Global configuration for code-crawler.
 *
 * All values can be overridden via environment variables so MCP clients can
 * point the server at different databases without code changes.
 */

/** Directory created inside a project to hold its database. */
export const DB_DIR_NAME = ".code-crawler";
/** Database file name inside that directory. */
export const DB_FILE_NAME = "index.db";

/**
 * Files and directories that identify a project root. A git checkout is the common case;
 * the build files cover repositories whose history is not present.
 */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
];

/** The database that belongs to one project: `<projectRoot>/.code-crawler/index.db`. */
export function databasePathFor(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), DB_DIR_NAME, DB_FILE_NAME);
}

/** The database used when no project can be determined, so each caller still gets a file. */
export function userDatabasePath(): string {
  return path.join(os.homedir(), DB_DIR_NAME, DB_FILE_NAME);
}

/** Project root that owns `start`, or `undefined` when no marker or database is found. */
export function findProjectRoot(start: string): string | undefined {
  return nearestDatabaseRoot(start);
}

/**
 * Nearest directory at or above `start` that either already owns a database or looks like a
 * project root. `undefined` when the walk reaches the filesystem root with neither.
 *
 * The user's home directory never answers for the directories beneath it. It is the fallback
 * location, not a project: an unmarked folder under `~` that inherited `~/.code-crawler`
 * would share one file with every other unmarked folder, and a crawl there would collide
 * with whatever the fallback file held last.
 */
export function nearestDatabaseRoot(start: string): string | undefined {
  const home = path.resolve(os.homedir());
  let dir = path.resolve(start);
  for (;;) {
    if (dir !== home) {
      if (fs.existsSync(path.join(dir, DB_DIR_NAME, DB_FILE_NAME))) return dir;
      if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return undefined;
    dir = parent;
  }
}

/**
 * Database for the project that encloses `start`. Used when the caller knows what is being
 * indexed, so a crawl of `repo/src` shares the database of `repo` rather than growing a
 * second, nested one that the server started at `repo` would never see.
 *
 * Unlike `defaultDatabasePath` this never returns the user-wide path: an explicit project
 * with no markers anywhere above it is still that project, not "somewhere global".
 */
export function projectDatabasePath(start: string): string {
  return databasePathFor(nearestDatabaseRoot(start) ?? start);
}

/**
 * Database to use when `CODECRAWLER_DB` is unset, resolved from `start` (the process cwd
 * unless a caller knows better).
 *
 * Walking up from the cwd gives each repository its own file, and keeps a client launched
 * in `src/` on the file the repo root created. The nearest match wins so a database is
 * never taken from above a project root.
 *
 * With no database and no project marker anywhere above it, the user-wide path is the
 * fallback: a client spawned with an unrelated cwd (Claude Desktop launches from its own
 * install directory) must not scatter databases into arbitrary directories. The home
 * directory itself is never treated as an enclosing project.
 */
export function defaultDatabasePath(start: string = process.cwd()): string {
  const root = nearestDatabaseRoot(start);
  return root === undefined ? userDatabasePath() : databasePathFor(root);
}

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

export function loadConfig(options: { projectRoot?: string } = {}): Config {
  const fallback = options.projectRoot
    ? projectDatabasePath(options.projectRoot)
    : defaultDatabasePath();
  return {
    dbPath: envStr("CODECRAWLER_DB", fallback),
    excludeDirs: [
      ...new Set(
        envStr(
          "CODECRAWLER_EXCLUDE_DIRS",
          ".git,node_modules,dist,build,target,.idea,.venv,.gradle,out,.next,coverage,.code-crawler"
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
