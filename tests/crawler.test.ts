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

  it("rejects non-directory project paths", async () => {
    await expect(
      crawlProject(store, "/nonexistent/path", loadConfig().excludeDirs, {})
    ).rejects.toThrow(/not a directory/);
  });
});
