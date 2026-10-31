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
