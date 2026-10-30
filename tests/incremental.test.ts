import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { crawlProject } from "../src/crawler.js";
import { loadConfig } from "../src/config.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "sample");

let store: GraphStore;
let project: string;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-inc-"));
  fs.cpSync(FIXTURES, project, { recursive: true });
});

afterEach(() => {
  store.close();
  fs.rmSync(project, { recursive: true, force: true });
});

function crawl() {
  return crawlProject(store, project, loadConfig().excludeDirs, {});
}

/** SQLite rowid per node id: stable only while a row is not rewritten. */
function nodeRowIds(): Record<string, number> {
  const rows = store.raw("SELECT rowid AS rid, id FROM nodes ORDER BY id") as {
    rid: number;
    id: string;
  }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.id] = row.rid;
  return out;
}

describe("incremental crawl", () => {
  it("parses everything on the first crawl", async () => {
    const result = await crawl();
    expect(result.filesParsed).toBe(8);
    expect(result.filesAdded).toBe(8);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesUnchanged).toBe(0);
    expect(store.listFileRecords().size).toBe(8);
  });

  it("replays the cache instead of rewriting an unchanged project", async () => {
    const first = await crawl();
    const before = nodeRowIds();

    const second = await crawl();
    expect(second.filesParsed).toBe(8);
    expect(second.filesAdded).toBe(0);
    expect(second.filesUpdated).toBe(0);
    expect(second.filesUnchanged).toBe(8);
    expect(second.resolvedCalls).toBe(first.resolvedCalls);
    expect(nodeRowIds()).toEqual(before);
  });

  it("replays a touched file whose content is unchanged", async () => {
    await crawl();
    const before = nodeRowIds();
    const target = path.join(project, "com", "acme", "Order.java");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(target, future, future);

    const result = await crawl();
    expect(result.filesUpdated).toBe(0);
    expect(result.filesUnchanged).toBe(8);
    expect(nodeRowIds()).toEqual(before);
    // The refreshed timestamp is persisted so the next crawl is a stat hit.
    expect(store.listFileRecords().get(target)?.mtimeMs).toBe(Math.trunc(future.getTime()));
  });

  it("re-parses and reindexes a single modified file", async () => {
    await crawl();
    expect(store.getNode("com.acme.Order#label")).toBeNull();

    const target = path.join(project, "com", "acme", "Order.java");
    const source = fs.readFileSync(target, "utf8");
    const patched = source.replace(/\}\s*$/, '    public String label() {\n        return "x";\n    }\n}\n');
    fs.writeFileSync(target, patched);

    const result = await crawl();
    expect(result.filesUpdated).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(result.filesUnchanged).toBe(7);
    expect(store.getNode("com.acme.Order#label")).not.toBeNull();
    expect(result.filesRemoved).toBe(0);
  });

  it("indexes a newly added file", async () => {
    await crawl();
    const added = path.join(project, "com", "acme", "Audit.java");
    fs.writeFileSync(
      added,
      "package com.acme;\n\npublic class Audit {\n    public void record(String what) {}\n}\n"
    );

    const result = await crawl();
    expect(result.filesAdded).toBe(1);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesUnchanged).toBe(8);
    expect(result.filesParsed).toBe(9);
    expect(store.getNode("com.acme.Audit#record")).not.toBeNull();
  });

  it("drops a removed file and keeps the rest cached", async () => {
    await crawl();
    fs.rmSync(path.join(project, "com", "acme", "Order.java"));

    const result = await crawl();
    expect(result.filesRemoved).toBe(1);
    expect(result.filesUnchanged).toBe(7);
    expect(result.filesParsed).toBe(7);
    expect(store.listFileRecords().size).toBe(7);
    expect(store.getNode("com.acme.Order")).toBeNull();
  });

  it("clears the manifest along with the graph", async () => {
    await crawl();
    store.clearAll();
    expect(store.listFileRecords().size).toBe(0);
    const result = await crawl();
    expect(result.filesAdded).toBe(8);
    expect(result.filesUnchanged).toBe(0);
  });
});
