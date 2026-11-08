import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { findEventFlows, searchSymbols } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

const JAVA_EVENTS = path.join(__dirname, "fixtures", "java", "events");

const tempDirs: string[] = [];

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-mig-"));
  tempDirs.push(dir);
  return path.join(dir, "index.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Windows can keep a brief handle on a just-closed database file.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** Rebuild a database that looks like the pre-P2 (v1) schema. */
function downgradeToV1(file: string): void {
  const db = new Database(file);
  db.exec(`
    DROP TRIGGER IF EXISTS nodes_fts_ai;
    DROP TRIGGER IF EXISTS nodes_fts_ad;
    DROP TRIGGER IF EXISTS nodes_fts_au;
    DROP TABLE IF EXISTS nodes_fts;
    DROP TABLE IF EXISTS files;
    DROP INDEX IF EXISTS idx_nodes_name_col;
    DROP INDEX IF EXISTS idx_edges_source_kind;
    DROP INDEX IF EXISTS idx_edges_target_kind;
    DROP INDEX IF EXISTS idx_nodes_entry_point;
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
    ALTER TABLE nodes DROP COLUMN name;
    UPDATE crawl_meta SET value = '1' WHERE key = 'schema_version';
  `);
  db.close();
}

describe("schema migration", () => {
  it("upgrades a v1 database in place", () => {
    const file = tempDb();
    const original = new GraphStore(file, { maxDepth: 10 });
    original.upsertNode({
      id: "com.acme.OrderService#place",
      kind: "method",
      qualifiedName: "com.acme.OrderService#place",
      filePath: "/tmp/OrderService.java",
      properties: { name: "place", startLine: 3 },
    });
    const latestVersion = original.schemaVersion;
    expect(latestVersion).toBeGreaterThanOrEqual(2);
    original.close();

    downgradeToV1(file);

    // The pre-migration database has no `name` column and no full-text index.
    const raw = new Database(file);
    const columns = (raw.prepare("PRAGMA table_info('nodes')").all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(columns).not.toContain("name");
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).not.toContain("files");
    expect(tables).not.toContain("nodes_fts");
    raw.close();

    const upgraded = new GraphStore(file, { maxDepth: 10 });
    try {
      expect(upgraded.schemaVersion).toBe(latestVersion);
      // v4 empties the graph on purpose: `EMITS` edges are only derivable from
      // a whole-project parse, so an index that predates it must be rebuilt
      // rather than patched. Nothing survives the upgrade.
      expect(upgraded.raw("SELECT id FROM nodes")).toEqual([]);
      expect(upgraded.listFileRecords().size).toBe(0);
      // The full-text index must not keep returning the rows that were dropped.
      expect(searchSymbols(upgraded, "place")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  it("invalidates a v3 index so the next crawl rebuilds event edges", async () => {
    const file = tempDb();
    const seeded = new GraphStore(file, { maxDepth: 10 });
    seeded.upsertNode({
      id: "com.acme.events.OrderPublisher#place",
      kind: "method",
      qualifiedName: "com.acme.events.OrderPublisher#place",
      filePath: "/tmp/OrderPublisher.java",
      properties: { name: "place", startLine: 3 },
    });
    seeded.close();

    // Rewind the stamp to simulate an index written before `EMITS` existed.
    const raw = new Database(file);
    raw.prepare("UPDATE crawl_meta SET value = '3' WHERE key = 'schema_version'").run();
    raw.close();

    const upgraded = new GraphStore(file, { maxDepth: 10 });
    try {
      expect(upgraded.schemaVersion).toBe(4);
      expect(upgraded.getNode("com.acme.events.OrderPublisher#place")).toBeNull();
    } finally {
      upgraded.close();
    }

    // A crawl repopulates it, and the derived pass produces the event edges the
    // old index could never have contained.
    const cached = new GraphStore(file, { maxDepth: 10 });
    try {
      await crawlProject(cached, JAVA_EVENTS, loadConfig().excludeDirs, {});
      const flows = findEventFlows(cached, { limit: 500 });
      expect(flows.length).toBeGreaterThan(0);
      expect(flows.map((f) => `${f.source.id} -> ${f.target.id}`)).toContain(
        "com.acme.events.OrderPublisher#place -> com.acme.notifications.OrderListeners#onPlaced"
      );
    } finally {
      cached.close();
    }
  });

  it("refuses a database written by a newer build", () => {
    const file = tempDb();
    const store = new GraphStore(file, { maxDepth: 10 });
    store.close();
    const raw = new Database(file);
    raw.prepare("UPDATE crawl_meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();
    expect(() => new GraphStore(file, { maxDepth: 10 })).toThrow(/newer than this build/);
  });
});
