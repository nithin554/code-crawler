import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { searchSymbols } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

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
    expect(original.schemaVersion).toBe(2);
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
      expect(upgraded.schemaVersion).toBe(2);
      // The display name is backfilled from the qualified name.
      const row = upgraded.raw(
        "SELECT name FROM nodes WHERE id = ?",
        "com.acme.OrderService#place"
      ) as {
        name: string | null;
      }[];
      expect(row[0]?.name).toBe("place");
      // The manifest exists and starts empty.
      expect(upgraded.listFileRecords().size).toBe(0);
      // The full-text index is rebuilt from the existing rows.
      expect(searchSymbols(upgraded, "place").map((s) => s.qualifiedName)).toEqual([
        "com.acme.OrderService#place",
      ]);
    } finally {
      upgraded.close();
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
