import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { crawlProject } from "../src/crawler.js";
import { getCallers, getCallees } from "../src/graph/queries.js";
import { loadConfig } from "../src/config.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "sample");

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

describe("crawlProject", () => {
  it("indexes all fixture files into a queryable graph", async () => {
    const result = await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    expect(result.filesParsed).toBe(8);
    expect(result.resolvedCalls).toBe(15);
    expect(result.unresolvedCalls).toBe(1);

    const stats = store.stats();
    expect(stats.nodes).toBe(39);
    expect(stats.edges).toBe(58);
    expect(stats.files).toBe(8);
  });

  it("is idempotent on re-crawl", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const first = store.stats();
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const second = store.stats();
    // Graph structure is identical; only the crawl timestamp advances.
    expect({ nodes: second.nodes, edges: second.edges, files: second.files }).toEqual({
      nodes: first.nodes,
      edges: first.edges,
      files: first.files,
    });
  });

  it("enables cross-file call queries", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});

    const callers = getCallers(store, "com.acme.OrderRepository#create", { transitive: true });
    expect(callers?.callers.map((c) => c.caller.qualifiedName)).toEqual([
      "com.acme.OrderService#place",
      "com.acme.Main#main",
    ]);

    const callees = getCallees(store, "com.acme.Main#main", { transitive: true });
    expect(callees?.callees.some((c) => c.callee.qualifiedName === "com.acme.Tracking#dispatch")).toBe(true);
  });

  it("creates synthetic nodes for implicit default constructors", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const ctor = store.getNode("com.acme.CustomerService#<init>");
    expect(ctor?.kind).toBe("constructor");
    expect(ctor?.properties.synthetic).toBe(true);
  });

  it("records phantom unknown symbols for unresolved calls", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const phantoms = store.raw("SELECT id FROM nodes WHERE kind='unknown_symbol'") as { id: string }[];
    expect(phantoms).toEqual([{ id: "__unknown__:System.out.println" }]);
  });

  it("removes stale files on re-crawl", async () => {
    // Work on a temp copy so parallel test workers never see a mutated fixture.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-crawl-"));
    fs.cpSync(FIXTURES, tmp, { recursive: true });
    try {
      await crawlProject(store, tmp, loadConfig().excludeDirs, {});
      const orderFile = path.join(tmp, "com", "acme", "Order.java");
      expect(store.getNode(orderFile)).not.toBeNull();

      // Delete the file, re-crawl, and confirm it disappears from the index.
      fs.rmSync(orderFile);
      await crawlProject(store, tmp, loadConfig().excludeDirs, {});
      expect(store.getNode(orderFile)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not delete out-of-scope files when fileFilter narrows a re-crawl", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-filter-"));
    try {
      const a = path.join(tmp, "a.py");
      const b = path.join(tmp, "b.py");
      fs.writeFileSync(a, "def a():\n    return 1\n");
      fs.writeFileSync(b, "def b():\n    return 2\n");

      await crawlProject(store, tmp, loadConfig().excludeDirs, {});
      const result = await crawlProject(store, tmp, loadConfig().excludeDirs, {
        fileFilter: "a.py",
      });

      expect(result.filesParsed).toBe(1);
      expect(result.filesRemoved).toBe(0);
      expect(result.pruned).toBe(false);
      expect(store.getNode(a)).not.toBeNull();
      expect(store.getNode(b)).not.toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores files whose extension does not match a forced language", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-language-"));
    try {
      fs.writeFileSync(path.join(tmp, "a.py"), "def a():\n    return 1\n");
      fs.writeFileSync(path.join(tmp, "b.py"), "def b():\n    return 2\n");
      fs.writeFileSync(path.join(tmp, "README.md"), "def not_python():\n    return 3\n");

      const result = await crawlProject(store, tmp, loadConfig().excludeDirs, {
        language: "python",
      });

      expect(result.filesScanned).toBe(2);
      expect(result.filesParsed).toBe(2);
      expect(store.getNode(path.join(tmp, "README.md"))).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restricts the javascript language option to JavaScript extensions", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-javascript-"));
    try {
      fs.writeFileSync(path.join(tmp, "app.js"), "function app() {\n  return 1;\n}\n");
      fs.writeFileSync(path.join(tmp, "types.ts"), "export function types(): number {\n  return 2;\n}\n");

      const result = await crawlProject(store, tmp, loadConfig().excludeDirs, {
        language: "javascript",
      });

      expect(result.filesParsed).toBe(1);
      expect(store.getNode(path.join(tmp, "app.js"))).not.toBeNull();
      expect(store.getNode(path.join(tmp, "types.ts"))).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to replace the index with a different project", async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-project-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-project-b-"));
    try {
      const a = path.join(first, "a.py");
      const b = path.join(second, "b.py");
      fs.writeFileSync(a, "def a():\n    return 1\n");
      fs.writeFileSync(b, "def b():\n    return 2\n");

      await crawlProject(store, first, loadConfig().excludeDirs, {});
      await expect(
        crawlProject(store, second, loadConfig().excludeDirs, {})
      ).rejects.toThrow(/already contains/);

      // The failed crawl must not have mutated the first project's index.
      expect(store.getNode(a)).not.toBeNull();
      expect(store.getNode(b)).toBeNull();
      expect(store.getMeta("last_project_path")).toBe(path.resolve(first));
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("garbage-collects file-less nodes that lost their last reference", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-orphan-"));
    try {
      const app = path.join(tmp, "app.py");
      fs.writeFileSync(app, "import requests\n\ndef fetch():\n    return requests.get('x')\n");

      await crawlProject(store, tmp, loadConfig().excludeDirs, {});
      expect(store.getNode("ext:requests")).not.toBeNull();

      fs.rmSync(app);
      const result = await crawlProject(store, tmp, loadConfig().excludeDirs, {});

      expect(store.getNode("ext:requests")).toBeNull();
      expect(result.orphansRemoved).toBeGreaterThan(0);
      expect(result.externalDependencies).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-directory project paths", async () => {
    await expect(
      crawlProject(store, "/nonexistent/path", loadConfig().excludeDirs, {})
    ).rejects.toThrow(/not a directory/);
  });
});
