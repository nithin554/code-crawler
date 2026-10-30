import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { type CrawlOptions, crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";

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

function crawl(options: Partial<CrawlOptions> = {}) {
  return crawlProject(store, project, loadConfig().excludeDirs, options);
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
    // libuv converts the `utimes` double into a timespec, so some platforms
    // read back a fraction below the requested millisecond and the crawler's
    // truncation lands 1ms low.
    const stored = store.listFileRecords().get(target)?.mtimeMs ?? Number.NaN;
    expect(Math.abs(stored - Math.trunc(future.getTime()))).toBeLessThanOrEqual(1);
  });

  it("re-parses and reindexes a single modified file", async () => {
    await crawl();
    expect(store.getNode("com.acme.Order#label")).toBeNull();

    const target = path.join(project, "com", "acme", "Order.java");
    const source = fs.readFileSync(target, "utf8");
    const patched = source.replace(
      /\}\s*$/,
      '    public String label() {\n        return "x";\n    }\n}\n'
    );
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

  it("replays a same-size edit with a restored mtime until forced", async () => {
    await crawl();
    expect(store.getNode("com.acme.OrderService#place")).not.toBeNull();

    const target = path.join(project, "com", "acme", "OrderService.java");
    const record = store.listFileRecords().get(target);
    if (!record) throw new Error("manifest record missing");
    const source = fs.readFileSync(target, "utf8");
    // `place` -> `fetch` keeps the byte length, so the size check cannot notice,
    // and putting the mtime back hides the edit from the timestamp check too.
    // This is the state `git checkout`, `rsync -t` and unzip leave behind.
    fs.writeFileSync(target, source.replaceAll("place", "fetch"));
    // libuv rounds the requested timestamp down by a fraction of a millisecond,
    // so nudge until the filesystem reports the millisecond the crawler stored.
    for (let delta = 0; delta < 5; delta++) {
      fs.utimesSync(target, record.mtimeMs / 1000, record.mtimeMs / 1000 + delta);
      if (Math.trunc(fs.statSync(target).mtimeMs) === record.mtimeMs) break;
    }
    const patched = fs.statSync(target);
    expect(patched.size).toBe(record.size);
    expect(Math.trunc(patched.mtimeMs)).toBe(record.mtimeMs);

    const stale = await crawl();
    expect(stale.filesUnchanged).toBe(8);
    expect(stale.filesUpdated).toBe(0);
    expect(store.getNode("com.acme.OrderService#fetch")).toBeNull();

    const forced = await crawl({ force: true });
    expect(forced.filesUnchanged).toBe(0);
    expect(forced.filesUpdated).toBe(8);
    expect(store.getNode("com.acme.OrderService#fetch")).not.toBeNull();
    expect(store.getNode("com.acme.OrderService#place")).toBeNull();
  });
});
