/**
 * Regenerates the parts of the documentation site that must never drift from
 * the code: every tool count, the homepage tool table, and the tool index on
 * the reference page.
 *
 * The source of truth is the live MCP registry, not a list in this file: the
 * script boots a real server over an in-memory store and reads `listTools()`.
 * A tool that exists but is not filed under a group, or a group that names a
 * tool which no longer exists, aborts the run with both lists, so the failure
 * names the drift instead of silently dropping a row.
 *
 * Hand-written content is preserved. Only two generated regions are rewritten,
 * plus any element carrying `data-tool-count`, plus the two count rows at the
 * top of ROADMAP.md:
 *
 *   <!-- BEGIN GENERATED:homepage-tools --> ... <!-- END GENERATED:homepage-tools -->
 *   <!-- BEGIN GENERATED:tools-index -->    ... <!-- END GENERATED:tools-index -->
 *
 * `npm run docs:generate` writes the files; `npm run docs:check` (and
 * `tests/docs-generated.test.ts`) fails when a file is stale.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";
import { TOOL_GROUPS, groupedToolNames } from "../src/toolGroups.js";

export interface RegisteredTool {
  name: string;
  description: string;
}

export const DOCS_DIR = path.join(process.cwd(), "docs");
export const HOMEPAGE = path.join(DOCS_DIR, "index.html");
export const TOOLS_PAGE = path.join(DOCS_DIR, "tools.html");
export const ROADMAP = path.join(process.cwd(), "ROADMAP.md");

/** Every HTML page under `docs/`, so a marked count is kept honest wherever it lives. */
export function docsPages(dir: string = DOCS_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Test files on disk, counted the same way `tests/docs.test.ts` counts them. */
export function countTestFiles(dir = path.join(process.cwd(), "tests")): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += countTestFiles(full);
    else if (entry.name.endsWith(".test.ts")) total += 1;
  }
  return total;
}

/** Names and descriptions straight from the MCP registry, in registration order. */
export async function loadToolRegistry(): Promise<RegisteredTool[]> {
  const store = new GraphStore(":memory:", { maxDepth: 10 });
  const server = createServer(store, loadConfig());
  const client = new Client({ name: "docs-generator", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  store.close();
  return tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
}

/**
 * Throws unless the registry and the group map describe the same set of tools.
 */
export function assertGroupsCover(registry: RegisteredTool[]): void {
  const registered = registry.map((tool) => tool.name);
  const grouped = groupedToolNames();
  const unregistered = grouped.filter((name) => !registered.includes(name));
  const unfiled = registered.filter((name) => !grouped.includes(name));
  const duplicated = grouped.filter((name, index) => grouped.indexOf(name) !== index);
  const problems: string[] = [];
  if (unfiled.length) problems.push(`not filed under any group: ${unfiled.join(", ")}`);
  if (unregistered.length) problems.push(`grouped but not registered: ${unregistered.join(", ")}`);
  if (duplicated.length) problems.push(`listed in more than one group: ${duplicated.join(", ")}`);
  if (problems.length) {
    throw new Error(
      `src/toolGroups.ts is out of step with the tool registry:\n  ${problems.join("\n  ")}`
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** First sentence of a tool description, shortened to fit one table cell. */
export function summaryOf(tool: RegisteredTool, max = 132): string {
  const text = tool.description.replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  if (first.length <= max) return escapeHtml(first);
  const cut = first.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${escapeHtml((boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trim())}&hellip;`;
}

/** Names of a group that the registry exposes, in registry order. */
function registeredInGroup(groupTools: string[], registry: RegisteredTool[]): string[] {
  const order = registry.map((tool) => tool.name);
  return groupTools
    .filter((name) => order.includes(name))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Body of the homepage tool table: one row per group. */
export function renderHomepageTable(registry: RegisteredTool[]): string {
  return TOOL_GROUPS.map((group) => {
    const names = registeredInGroup(group.tools, registry)
      .map((name) => `<code>${name}</code>`)
      .join(" ");
    return [
      "                <tr>",
      `                  <td>${group.title}</td>`,
      "                  <td>",
      `                    ${names}`,
      "                  </td>",
      `                  <td>${group.answers}</td>`,
      "                </tr>",
    ].join("\n");
  }).join("\n");
}

/** Body of the reference-page index: every tool, grouped, with its summary. */
export function renderToolIndex(registry: RegisteredTool[]): string {
  const byName = new Map(registry.map((tool) => [tool.name, tool]));
  return TOOL_GROUPS.flatMap((group) =>
    registeredInGroup(group.tools, registry).map((name) => {
      const tool = byName.get(name);
      return [
        "                <tr>",
        `                  <td><code>${name}</code></td>`,
        `                  <td><a href="#${group.id}">${group.title}</a></td>`,
        `                  <td>${tool ? summaryOf(tool) : ""}</td>`,
        "                </tr>",
      ].join("\n");
    })
  ).join("\n");
}

/** Text of every element marked `data-tool-count`. */
export function renderCounts(html: string, count: number): string {
  return html.replace(
    /(<([a-z]+)\b[^>]*\sdata-tool-count\b[^>]*>)([^<]*)(<\/\2>)/g,
    (_match, open: string, _tag: string, _body: string, close: string) =>
      `${open}${count}${close}`
  );
}

/** Replaces the region between a pair of generated markers, keeping the markers. */
export function replaceRegion(html: string, region: string, body: string): string {
  const begin = `<!-- BEGIN GENERATED:${region} -->`;
  const end = `<!-- END GENERATED:${region} -->`;
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`documentation is missing the "${region}" generated markers`);
  }
  return `${html.slice(0, from + begin.length)}\n${body}\n${html.slice(to)}`;
}

export function renderHomepage(html: string, registry: RegisteredTool[]): string {
  assertGroupsCover(registry);
  return replaceRegion(renderCounts(html, registry.length), "homepage-tools", renderHomepageTable(registry));
}

export function renderToolsPage(html: string, registry: RegisteredTool[]): string {
  assertGroupsCover(registry);
  return replaceRegion(renderCounts(html, registry.length), "tools-index", renderToolIndex(registry));
}

/**
 * The two counts at the top of the roadmap. They are rewritten in place rather
 * than regioned, because the surrounding prose is hand-written.
 */
export function renderRoadmap(
  text: string,
  registry: RegisteredTool[],
  testFileCount: number
): string {
  const tools = /^(\|\s*Tools\s*\|\s*)(\d+)(\s*MCP tools)/m;
  const tests = /^(\|\s*Tests\s*\|\s*)(\d+)(\s*test files)/m;
  if (!tools.test(text) || !tests.test(text)) {
    throw new Error("ROADMAP.md is missing its Tools or Tests count row");
  }
  return text
    .replace(tools, `$1${registry.length}$3`)
    .replace(tests, `$1${testFileCount}$3`);
}

export interface DocTarget {
  file: string;
  /** Renders `text` against the live registry, preserving markers and prose. */
  render: (text: string, tools: RegisteredTool[]) => string;
}

/**
 * Every file the generator owns: the two pages with generated regions, the
 * roadmap rows, and the marked counts on any other page.
 */
export function docTargets(): DocTarget[] {
  return [
    { file: HOMEPAGE, render: renderHomepage },
    { file: TOOLS_PAGE, render: renderToolsPage },
    {
      file: ROADMAP,
      render: (text: string, tools: RegisteredTool[]) =>
        renderRoadmap(text, tools, countTestFiles()),
    },
    ...docsPages()
      .filter((file) => file !== HOMEPAGE && file !== TOOLS_PAGE)
      .map((file) => ({
        file,
        render: (text: string, tools: RegisteredTool[]) => renderCounts(text, tools.length),
      })),
  ];
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const registry = await loadToolRegistry();
  const stale: string[] = [];
  for (const { file, render } of docTargets()) {
    const before = fs.readFileSync(file, "utf8");
    const after = render(before, registry);
    if (before === after) continue;
    if (check) {
      stale.push(path.basename(file));
      continue;
    }
    fs.writeFileSync(file, after);
    process.stdout.write(`updated ${path.basename(file)}\n`);
  }
  if (stale.length) {
    process.stderr.write(
      `documentation is stale: ${stale.join(", ")}. Run \`npm run docs:generate\`.\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${registry.length} tools, documentation ${check ? "in sync" : "up to date"}\n`
  );
}

if (process.argv[1]?.endsWith("generate-docs.ts")) await main();
