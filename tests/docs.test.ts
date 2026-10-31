import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { listLanguageDescriptors, listLanguages } from "../src/parser/languages/index.js";
import { createServer } from "../src/server.js";

const ROOT = path.join(__dirname, "..");

function doc(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

/** Body of a `## heading` section, up to the next level-2 heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`documentation is missing ${heading}`);
  const body = markdown.slice(start + heading.length);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
}

/** Rows of the first markdown table in `block`, separator row removed. */
function tableRows(block: string): string[][] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) found.push(full);
    }
  };
  walk(path.join(ROOT, "tests"));
  return found;
}

/**
 * Documentation drift guard.
 *
 * Counts and tool/language lists in README.md and ROADMAP.md are asserted
 * against the code so they cannot silently rot as tools and languages land.
 */

let toolNames: string[];

beforeAll(async () => {
  const store = new GraphStore(":memory:", { maxDepth: 10 });
  const server = createServer(store, loadConfig());
  const client = new Client({ name: "docs-test", version: "1.0.0" });
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

describe("documentation matches the code", () => {
  it("README documents exactly the tools the server exposes", () => {
    const rows = tableRows(section(doc("README.md"), "## MCP surface"));
    const documented = rows
      .map((cells) => /^`([a-z_]+)`$/.exec(cells[0] ?? "")?.[1])
      .filter((name): name is string => Boolean(name))
      .sort();
    expect(documented).toEqual(toolNames);
  });

  it("ROADMAP states the real tool count", () => {
    const match = /\|\s*Tools\s*\|\s*(\d+)\s*MCP tools/.exec(doc("ROADMAP.md"));
    expect(match?.[1]).toBe(String(toolNames.length));
  });

  it("ROADMAP states the real test-file count", () => {
    const match = /\|\s*Tests\s*\|\s*(\d+)\s*test files/.exec(doc("ROADMAP.md"));
    expect(match?.[1]).toBe(String(testFiles().length));
  });

  it("README's language table matches the parser registry", () => {
    const rows = tableRows(section(doc("README.md"), "## Implemented languages"));
    const documented = rows
      .slice(1)
      .map((cells) => (cells[0] ?? "").toLowerCase())
      .sort();
    // JavaScript shares the TypeScript parser but is advertised separately.
    expect(documented).toEqual([...listLanguages(), "javascript"].sort());
  });

  it("README lists exactly the extensions each descriptor claims", () => {
    // One descriptor may be advertised as two rows: JavaScript shares the
    // TypeScript parser but earns its own line in the table.
    const aliasRows: Record<string, string[]> = { typescript: ["javascript"] };
    const rows = tableRows(section(doc("README.md"), "## Implemented languages"));
    for (const descriptor of listLanguageDescriptors()) {
      const names = [descriptor.name, ...(aliasRows[descriptor.name] ?? [])];
      const documented = names
        .flatMap((name) => rows.find((cells) => (cells[0] ?? "").toLowerCase() === name)?.[1] ?? "")
        .join(" ")
        .match(/\.[a-z0-9]+/gi)
        ?.map((token) => token.slice(1).toLowerCase())
        .sort();
      expect(documented, descriptor.name).toEqual([...descriptor.extensions].sort());
    }
  });

  it("documents what is not modelled for every language", () => {
    for (const source of ["README.md", "USAGE.md"]) {
      const text = doc(source);
      for (const language of listLanguages()) {
        expect(text, `${source} has no "${language}" not-modelled entry`).toContain(
          `\`${language}\``
        );
      }
    }
  });
});
