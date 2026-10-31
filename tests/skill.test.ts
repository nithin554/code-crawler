import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";

const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "skills", "code-crawler");
const SKILL = path.join(SKILL_DIR, "SKILL.md");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Minimal YAML frontmatter reader for the flat `key: value` block skills use. */
function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** First-column tool names from every markdown table in `markdown`. */
function toolRows(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const first = trimmed.slice(1, -1).split("|")[0]?.trim() ?? "";
    const name = /^`([a-z][a-z0-9_]*)`$/.exec(first)?.[1];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Skill drift guard.
 *
 * The skill is documentation an agent loads on demand, so it rots silently unless it is
 * asserted against the tool registry - the same guard shape as docs.test.ts.
 */

let toolNames: string[];

beforeAll(async () => {
  const store = new GraphStore(":memory:", { maxDepth: 10 });
  const server = createServer(store, loadConfig());
  const client = new Client({ name: "skill-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  toolNames = tools.map((tool) => tool.name).sort();
  await client.close();
  store.close();
});

afterAll(() => {
  expect(toolNames.length).toBeGreaterThan(0);
});

describe("skill frontmatter", () => {
  it("parses and declares a valid skill identifier", () => {
    const meta = frontmatter(read(SKILL));
    expect(meta.name).toBe("code-crawler");
    expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("names the directory it lives in", () => {
    expect(path.basename(SKILL_DIR)).toBe(frontmatter(read(SKILL)).name);
  });

  it("has a description that says when to use it", () => {
    const { description } = frontmatter(read(SKILL));
    expect(description).toBeDefined();
    // Discovery depends entirely on this string, so it must carry a trigger phrase.
    expect(description.toLowerCase()).toContain("use when");
    expect(description.length).toBeGreaterThan(120);
  });
});

describe("skill matches the tool registry", () => {
  it("documents exactly the tools the server exposes", () => {
    const documented = [...new Set(toolRows(read(path.join(SKILL_DIR, "reference", "tools.md"))))];
    expect(documented.sort()).toEqual(toolNames);
  });

  it("states the real tool count in both files", () => {
    const skillCount = /(\d+) MCP tools/.exec(read(SKILL))?.[1];
    expect(skillCount).toBe(String(toolNames.length));
    const refCount = /All (\d+) tools/.exec(
      read(path.join(SKILL_DIR, "reference", "tools.md"))
    )?.[1];
    expect(refCount).toBe(String(toolNames.length));
  });

  it("only names tools that exist", () => {
    const known = new Set(toolNames);
    const mentioned = read(SKILL).match(/`([a-z][a-z0-9_]*)`/g) ?? [];
    // Tool names all start with one of the registry's verbs; this keeps parameter
    // names such as `max_tokens` out of the check.
    const toolish = /^(get|find|trace|crawl|index|search|export|clear|impact|explain)_/;
    const bad = mentioned
      .map((token) => token.slice(1, -1))
      .filter((name) => toolish.test(name) && !known.has(name));
    expect(bad).toEqual([]);
  });
});

describe("skill guidance", () => {
  it("teaches the crawl-first workflow", () => {
    const skill = read(SKILL);
    expect(skill).toContain("crawl_project");
    expect(skill).toContain("index_status");
  });

  it("warns that a stale index produces false negatives", () => {
    const skill = read(SKILL).toLowerCase();
    expect(skill).toContain("stale");
    expect(skill).toContain("force");
  });

  it("links only reference documents that exist", () => {
    const links = [...read(SKILL).matchAll(/\]\((reference\/[^)\s]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(fs.existsSync(path.join(SKILL_DIR, link)), `${link} is missing`).toBe(true);
    }
  });
});

describe("skill install instructions", () => {
  const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as {
    name: string;
    engines: { node: string };
    bin: Record<string, string>;
    repository: { url: string };
  };

  it("names the real published package", () => {
    // A rename would otherwise leave the skill telling agents to run a package that
    // does not exist.
    expect(read(SKILL)).toContain(pkg.name);
  });

  it("documents the real bin command", () => {
    const commands = Object.keys(pkg.bin);
    expect(commands.length).toBeGreaterThan(0);
    const skill = read(SKILL);
    for (const command of commands) {
      // Prose uses backticks, the config snippet uses JSON quotes.
      expect(skill, `${command} is not documented`).toMatch(new RegExp(`[\`"]${command}[\`"]`));
    }
  });

  it("points the skills CLI at the real repository", () => {
    // `npx skills add owner/repo` discovers skills/<name>/SKILL.md by convention, so a
    // wrong owner or repo name installs nothing at all.
    const remote = /github\.com[/:]([^/\s]+)\/([^/\s.]+?)(?:\.git)?\s*$/.exec(pkg.repository.url);
    expect(remote, `unrecognised repository url: ${pkg.repository.url}`).not.toBeNull();
    const shorthand = /npx skills add ([a-z0-9-]+\/[a-z0-9-]+)/i.exec(read(SKILL));
    expect(shorthand?.[1], "SKILL.md does not document `npx skills add`").toBe(
      `${remote?.[1]}/${remote?.[2]}`
    );
  });

  it("documents the add-mcp installer for the server", () => {
    // add-mcp registers the server, and a wrong package name there installs nothing.
    // Leaving it out entirely pushes the agent into hand-editing a config it does not own.
    const addMcp = /npx add-mcp (@[a-z0-9-]+\/[a-z0-9-]+)/i.exec(read(SKILL))?.[1];
    expect(addMcp, "SKILL.md does not document `npx add-mcp`").toBe(pkg.name);
  });

  it("offers the one-line installers from every entry point", () => {
    // README, USAGE, and the docs site are where people land first. An installer
    // documented in only one of them is effectively hidden.
    const surfaces = [
      "README.md",
      "USAGE.md",
      path.join("docs", "index.html"),
      path.join("docs", "skill.html"),
      path.join("docs", "usage.html"),
    ];
    for (const surface of surfaces) {
      expect(read(path.join(ROOT, surface)), `${surface} does not mention add-mcp`).toContain(
        "add-mcp"
      );
      expect(read(path.join(ROOT, surface)), `${surface} does not mention skills add`).toMatch(
        /skills add|skills\.sh/
      );
    }
  });

  it("says that installing the skill does not install the server", () => {
    // The two installs are independent; conflating them leaves an agent with
    // instructions and no tools.
    expect(read(SKILL).toLowerCase()).toContain("does not install the *server*".toLowerCase());
  });

  it("states a Node floor that matches engines.node", () => {
    const required = /(\d+(?:\.\d+)*)/.exec(pkg.engines.node)?.[1];
    expect(required).toBeDefined();
    expect(read(SKILL), `Node ${required} is not documented`).toContain(`≥ ${required}`);
  });

  it("shows a client config block with an absolute database path", () => {
    const skill = read(SKILL);
    expect(skill).toContain('"mcpServers"');
    expect(skill).toContain('"command"');
    expect(skill).toContain("/absolute/path/to/index.db");
  });

  it("warns that a database holds exactly one project", () => {
    // Otherwise an agent points a second repository at the default database and
    // gets a clear_index error instead of a graph.
    const skill = read(SKILL).toLowerCase();
    expect(skill).toContain("exactly one project");
    expect(skill).toContain("clear_index");
  });

  it("says that CODECRAWLER_DB is optional wherever the flag is shown", () => {
    // The one-liners pass --env CODECRAWLER_DB, which reads as mandatory. It is not:
    // src/config.ts resolves <project>/.code-crawler/index.db from the cwd when the
    // variable is unset or empty, and store.ts creates the directory. Saying so next to
    // the command is what stops a reader hunting for a value they do not need.
    const configSrc = read(path.join(ROOT, "src", "config.ts"));
    const dirName = /export const DB_DIR_NAME = "([^"]+)";/.exec(configSrc)?.[1];
    const fileName = /export const DB_FILE_NAME = "([^"]+)";/.exec(configSrc)?.[1];
    expect(dirName, "DB_DIR_NAME is unreadable from src/config.ts").toBeTruthy();
    expect(fileName, "DB_FILE_NAME is unreadable from src/config.ts").toBeTruthy();
    const defaultRelative = `${dirName}/${fileName}`;

    const surfaces = [
      "README.md",
      "USAGE.md",
      path.join("skills", "code-crawler", "SKILL.md"),
      path.join("docs", "index.html"),
      path.join("docs", "skill.html"),
      path.join("docs", "usage.html"),
    ];
    for (const surface of surfaces) {
      const text = read(path.join(ROOT, surface));
      const at = text.indexOf("--env CODECRAWLER_DB=");
      if (at === -1) continue;
      // Adjacent, not merely somewhere on the page: a stray "optional" in a config
      // section three screens away does not help the reader of this command.
      const nearby = text.slice(Math.max(0, at - 900), at + 900).toLowerCase();
      expect(nearby, `${surface} passes CODECRAWLER_DB without saying it is optional`).toContain(
        "optional"
      );
      expect(
        nearby,
        `${surface} does not name the per-project default ${defaultRelative}`
      ).toContain(defaultRelative.toLowerCase());
    }
  });

  it("documents the database default as one file per project", () => {
    // The whole point of the resolution rule: a reader should not be told to configure
    // anything to keep two repositories apart.
    for (const surface of [
      "README.md",
      "USAGE.md",
      path.join("skills", "code-crawler", "SKILL.md"),
    ]) {
      const text = read(path.join(ROOT, surface)).toLowerCase();
      expect(text, `${surface} never mentions .code-crawler/index.db`).toContain(
        ".code-crawler/index.db"
      );
      expect(text, `${surface} does not say each project gets its own file`).toMatch(
        /each (?:repository|project)[^.]{0,80}(?:own file|own database)/
      );
    }
  });

  it("registers per project instead of globally in every add-mcp example", () => {
    // A global registration whose working directory is not the project lands on the
    // user-wide fallback, where every repository then collides on the one-project guard.
    for (const surface of [
      "README.md",
      "USAGE.md",
      path.join("skills", "code-crawler", "SKILL.md"),
      path.join("docs", "index.html"),
      path.join("docs", "skill.html"),
      path.join("docs", "usage.html"),
    ]) {
      const text = read(path.join(ROOT, surface));
      const invocations = text
        .split(/\r?\n/)
        .filter((line) => line.includes("add-mcp @nithin554/code-crawler"));
      expect(invocations.length, `${surface} never shows an add-mcp command`).toBeGreaterThan(0);
      for (const invocation of invocations) {
        expect(
          invocation,
          `${surface} registers add-mcp globally with -g: ${invocation.trim()}`
        ).not.toMatch(/(?:^|\s)-g(?:\s|$)/);
      }
    }
  });

  it("explains that one server serves one project", () => {
    // The consequence readers hit second: a database holds one project, so a single
    // global server cannot serve several repositories.
    for (const surface of [
      "README.md",
      "USAGE.md",
      path.join("skills", "code-crawler", "SKILL.md"),
    ]) {
      const text = read(path.join(ROOT, surface));
      expect(text, `${surface} never says one server serves one project`).toMatch(
        /one server per project|one server serves one project/i
      );
    }
  });

  it("only names environment variables the config actually reads", () => {
    const config = read(path.join(ROOT, "src", "config.ts"));
    const real = new Set(config.match(/CODECRAWLER_[A-Z_]+/g) ?? []);
    const mentioned = new Set(read(SKILL).match(/CODECRAWLER_[A-Z_]+/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0);
    const bogus = [...mentioned].filter((name) => !real.has(name));
    expect(bogus).toEqual([]);
  });
});

describe("skill reference documents", () => {
  it("documents the confidence bands the resolver actually emits", () => {
    const semantics = read(path.join(SKILL_DIR, "reference", "edge-semantics.md"));
    for (const band of ["1.0", "0.9", "0.85", "0.8", "0.75", "0.6", "0.55", "0.3", "0"]) {
      expect(semantics, `confidence band ${band} is undocumented`).toContain(`\`${band}\``);
    }
  });

  it("documents every phantom node prefix", () => {
    const semantics = read(path.join(SKILL_DIR, "reference", "edge-semantics.md"));
    for (const prefix of ["__phantom__:", "__reflect__:", "__inject__:"]) {
      expect(semantics).toContain(prefix);
    }
  });

  it("documents every edge kind in the schema", () => {
    const semantics = read(path.join(SKILL_DIR, "reference", "edge-semantics.md"));
    const schema = read(path.join(ROOT, "src", "graph", "schema.ts"));
    const kinds = /EDGE_KINDS = \[([\s\S]*?)\]/.exec(schema)?.[1] ?? "";
    const names = [...kinds.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const kind of names) {
      expect(semantics, `edge kind ${kind} is undocumented`).toContain(`\`${kind}\``);
    }
  });
});
