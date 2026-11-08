import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertGroupsCover,
  countTestFiles,
  docTargets,
  HOMEPAGE,
  loadToolRegistry,
  type RegisteredTool,
  ROADMAP,
  renderCounts,
  renderHomepage,
  renderRoadmap,
  renderToolsPage,
  replaceRegion,
  summaryOf,
  TOOLS_PAGE,
} from "../scripts/generate-docs.js";
import { groupOf, TOOL_GROUPS } from "../src/toolGroups.js";

const DOCS = path.join(process.cwd(), "docs");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function pages(): string[] {
  return fs
    .readdirSync(DOCS)
    .filter((name) => name.endsWith(".html"))
    .sort();
}

function navOf(file: string): string {
  return /<div class="nav-links">([\s\S]*?)<\/div>/.exec(read(path.join(DOCS, file)))?.[1] ?? "";
}

/**
 * Documentation is generated from the tool registry.
 *
 * `docs/index.html`, `docs/tools.html` and `ROADMAP.md` carry generated counts.
 * These tests re-render them against the live registry and fail when the
 * checked-in files are stale, so a new tool cannot ship with documentation that
 * still says the old number. The fix is always `npm run docs:generate`.
 */

let registry: RegisteredTool[];

beforeAll(async () => {
  registry = await loadToolRegistry();
});

describe("generated documentation", () => {
  it("finds tools in the registry", () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it("has a homepage that is not stale", () => {
    const current = read(HOMEPAGE);
    expect(renderHomepage(current, registry)).toBe(current);
  });

  it("has a tool reference that is not stale", () => {
    const current = read(TOOLS_PAGE);
    expect(renderToolsPage(current, registry)).toBe(current);
  });

  it("keeps the roadmap counts in step", () => {
    const current = read(ROADMAP);
    expect(renderRoadmap(current, registry, countTestFiles())).toBe(current);
  });

  it("files every registered tool under exactly one group", () => {
    expect(() => assertGroupsCover(registry)).not.toThrow();
    for (const tool of registry) {
      expect(TOOL_GROUPS.filter((group) => group.tools.includes(tool.name)).length, tool.name).toBe(
        1
      );
      expect(groupOf(tool.name), tool.name).toBeDefined();
    }
  });

  it("gives every group an anchor that exists on the reference page", () => {
    const html = read(TOOLS_PAGE);
    for (const group of TOOL_GROUPS) {
      expect(html, group.id).toContain(`id="${group.id}"`);
    }
  });

  it("documents every registered tool with a detail block", () => {
    const html = read(TOOLS_PAGE);
    for (const tool of registry) {
      expect(html, `${tool.name} has no reference entry`).toContain(`<code>${tool.name}</code>`);
    }
  });

  it("states the real tool count in every marked element", () => {
    const marked = pages()
      .map((file) => read(path.join(DOCS, file)))
      .flatMap((html) =>
        [...html.matchAll(/<([a-z]+)\b[^>]*\sdata-tool-count\b[^>]*>([^<]*)<\/\1>/g)].map(
          (match) => match[2]
        )
      );
    expect(marked.length).toBeGreaterThan(0);
    for (const count of marked) {
      expect(count).toBe(String(registry.length));
    }
  });

  it("makes the generator responsible for every page, not just the homepage", () => {
    const targets = docTargets();
    const covered = targets.map((target) => path.basename(target.file));
    expect(covered).toEqual(expect.arrayContaining(pages()));
    expect(covered).toContain("ROADMAP.md");
    for (const target of targets) {
      const current = read(target.file);
      expect(target.render(current, registry), `${path.basename(target.file)} is stale`).toBe(
        current
      );
    }
  });
});

describe("site navigation", () => {
  it("links every page from every page", () => {
    const wanted = new Set(pages());
    for (const file of pages()) {
      const linked = new Set(
        [...navOf(file).matchAll(/href="([^"]+)"/g)].map((m) =>
          m[1] === "./" ? "index.html" : m[1]
        )
      );
      const missing = [...wanted].filter((page) => !linked.has(page));
      expect(missing, `${file} does not link ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("lists every page in the sitemap", () => {
    const sitemap = read(path.join(DOCS, "sitemap.xml"));
    for (const file of pages()) {
      const slug = file === "index.html" ? "" : file;
      expect(sitemap, `${file} is not in sitemap.xml`).toContain(
        `https://nithin554.github.io/code-crawler/${slug}`
      );
    }
  });

  it("marks exactly one nav link as current", () => {
    for (const file of pages()) {
      const current = [...navOf(file).matchAll(/aria-current="page"/g)].length;
      expect(current, `${file} marks ${current} links current`).toBe(1);
    }
  });
});

describe("generator helpers", () => {
  it("rewrites only the text of marked elements", () => {
    const html = '<p class="x" data-tool-count>1</p><span><b data-tool-count>1</b></span>';
    expect(renderCounts(html, 42)).toBe(
      '<p class="x" data-tool-count>42</p><span><b data-tool-count>42</b></span>'
    );
  });

  it("leaves unmarked numbers alone", () => {
    const html = "<p>14 edge kinds</p>";
    expect(renderCounts(html, 29)).toBe(html);
  });

  it("replaces a marked region and keeps the markers", () => {
    const html = "a<!-- BEGIN GENERATED:x -->old<!-- END GENERATED:x -->b";
    expect(replaceRegion(html, "x", "new")).toBe(
      "a<!-- BEGIN GENERATED:x -->\nnew\n<!-- END GENERATED:x -->b"
    );
  });

  it("fails loudly when a region marker is missing", () => {
    expect(() => replaceRegion("no markers here", "x", "new")).toThrow(/x/);
  });

  it("fails loudly when a roadmap row is missing", () => {
    expect(() => renderRoadmap("| Layout | 4 files |", registry, 42)).toThrow(/Tools or Tests/);
  });

  it("counts the test files on disk", () => {
    const direct = fs
      .readdirSync(path.join(process.cwd(), "tests"))
      .filter((n) => n.endsWith(".test.ts"));
    expect(countTestFiles()).toBe(direct.length);
  });

  it("takes the first sentence and shortens long ones", () => {
    expect(summaryOf({ name: "a", description: "First. Second." })).toBe("First.");
    const long = summaryOf({ name: "b", description: `${"word ".repeat(60)}.` }, 40);
    expect(long.endsWith("&hellip;")).toBe(true);
    expect(long.length).toBeLessThan(50);
  });

  it("escapes markup in a description", () => {
    expect(summaryOf({ name: "c", description: "Use <T> & co. Then stop." })).toBe(
      "Use &lt;T&gt; &amp; co."
    );
  });
});
