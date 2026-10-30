import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig } from "../src/config.js";

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
});
