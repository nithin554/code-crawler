import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  databasePathFor,
  defaultDatabasePath,
  loadConfig,
  userDatabasePath,
} from "../src/config.js";

const ENV_VARS = [
  "CODECRAWLER_DB",
  "CODECRAWLER_EXCLUDE_DIRS",
  "CODECRAWLER_DEFAULT_LIMIT",
  "CODECRAWLER_MAX_DEPTH",
  "CODECRAWLER_MAX_FILE_BYTES",
  "CODECRAWLER_RESPECT_GITIGNORE",
  "CODECRAWLER_HELPFUL_ERRORS",
] as const;

const saved = new Map<string, string | undefined>();

const temporaries: string[] = [];

/** A throwaway directory tree, removed after each test. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-config-"));
  temporaries.push(root);
  return root;
}

function setEnv(values: Partial<Record<(typeof ENV_VARS)[number], string>>): void {
  for (const name of ENV_VARS) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

function captureWarnings(): string[] {
  const messages: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    messages.push(String(chunk));
    return true;
  });
  return messages;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaries.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const name of ENV_VARS) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("loadConfig", () => {
  it("provides documented defaults", () => {
    setEnv({});
    const config = loadConfig();
    expect(config.defaultLimit).toBe(50);
    expect(config.maxDepth).toBe(10);
    expect(config.maxFileBytes).toBe(1_000_000);
    expect(config.respectGitignore).toBe(true);
    expect(config.helpfulErrors).toBe(true);
  });

  it("accepts common boolean spellings", () => {
    setEnv({ CODECRAWLER_RESPECT_GITIGNORE: "no", CODECRAWLER_HELPFUL_ERRORS: "ON" });
    const config = loadConfig();
    expect(config.respectGitignore).toBe(false);
    expect(config.helpfulErrors).toBe(true);
  });

  it("falls back with a warning when a boolean is unparseable", () => {
    const warnings = captureWarnings();
    setEnv({ CODECRAWLER_HELPFUL_ERRORS: "maybe" });
    expect(loadConfig().helpfulErrors).toBe(true);
    expect(warnings.join("")).toMatch(/CODECRAWLER_HELPFUL_ERRORS/);
  });

  it("falls back with a warning when an integer is unparseable", () => {
    const warnings = captureWarnings();
    setEnv({ CODECRAWLER_MAX_DEPTH: "abc" });
    expect(loadConfig().maxDepth).toBe(10);
    expect(warnings.join("")).toMatch(/CODECRAWLER_MAX_DEPTH/);
  });

  it("clamps out-of-range integers instead of trusting them", () => {
    const warnings = captureWarnings();
    setEnv({
      CODECRAWLER_MAX_DEPTH: "9999",
      CODECRAWLER_DEFAULT_LIMIT: "0",
      CODECRAWLER_MAX_FILE_BYTES: "1",
    });
    const config = loadConfig();
    expect(config.maxDepth).toBe(100);
    expect(config.defaultLimit).toBe(1);
    expect(config.maxFileBytes).toBe(1024);
    expect(warnings.join("")).toMatch(/between/);
  });

  it("truncates fractional integers", () => {
    setEnv({ CODECRAWLER_DEFAULT_LIMIT: "12.9" });
    expect(loadConfig().defaultLimit).toBe(12);
  });

  it("deduplicates the excluded directory list", () => {
    setEnv({ CODECRAWLER_EXCLUDE_DIRS: "node_modules, node_modules ,dist,,out" });
    expect(loadConfig().excludeDirs).toEqual(["node_modules", "dist", "out"]);
  });

  it("never crawls its own database directory", () => {
    setEnv({});
    expect(loadConfig().excludeDirs).toContain(".code-crawler");
  });
});

describe("project-scoped database", () => {
  it("places the database inside the project root", () => {
    setEnv({});
    const root = makeRoot();
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "src", "deep", "deeper"), { recursive: true });

    const expected = path.join(root, ".code-crawler", "index.db");
    expect(databasePathFor(root)).toBe(expected);
    expect(defaultDatabasePath(path.join(root, "src", "deep", "deeper"))).toBe(expected);
  });

  it("recognises projects without a git checkout", () => {
    setEnv({});
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "pyproject.toml"), "");
    fs.mkdirSync(path.join(root, "app"), { recursive: true });

    expect(defaultDatabasePath(path.join(root, "app"))).toBe(
      path.join(root, ".code-crawler", "index.db")
    );
  });

  it("resolves the nearest database rather than one above the project", () => {
    setEnv({});
    const root = makeRoot();
    const outer = path.join(root, "outer");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
    // A stale database sits closer to the caller than outer's project marker.
    fs.mkdirSync(path.join(inner, ".code-crawler"), { recursive: true });
    fs.writeFileSync(path.join(inner, ".code-crawler", "index.db"), "");
    fs.mkdirSync(path.join(inner, "src"), { recursive: true });

    expect(defaultDatabasePath(path.join(inner, "src"))).toBe(
      path.join(inner, ".code-crawler", "index.db")
    );
  });

  it("falls back to the user-wide path when no project encloses the cwd", () => {
    setEnv({});
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(defaultDatabasePath(makeRoot())).toBe(userDatabasePath());
    expect(userDatabasePath()).toBe(path.join(os.homedir(), ".code-crawler", "index.db"));
  });

  it("lets CODECRAWLER_DB override the project database", () => {
    setEnv({ CODECRAWLER_DB: path.join(os.tmpdir(), "explicit.db") });
    expect(loadConfig({ projectRoot: makeRoot() }).dbPath).toBe(
      path.join(os.tmpdir(), "explicit.db")
    );
  });

  it("uses the project database when CODECRAWLER_DB is unset or empty", () => {
    const root = makeRoot();
    const expected = path.join(root, ".code-crawler", "index.db");
    setEnv({});
    expect(loadConfig({ projectRoot: root }).dbPath).toBe(expected);
    setEnv({ CODECRAWLER_DB: "" });
    expect(loadConfig({ projectRoot: root }).dbPath).toBe(expected);
  });
});
