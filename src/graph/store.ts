import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  EdgeKind,
  EdgeProperties,
  GraphEdge,
  GraphNode,
  NodeKind,
  NodeProperties,
} from "./schema.js";

/**
 * SQLite-backed property graph store.
 *
 * Responsibilities:
 *  - Create/own the schema (WAL mode, foreign keys, indexes).
 *  - Upsert nodes and edges (idempotent).
 *  - Support file-scoped reindexing: removing one file must not disturb
 *    symbols referenced from other files.
 *  - Provide count/status introspection.
 *
 * The store is synchronous (better-sqlite3), which keeps the MCP tool
 * handlers simple and predictable.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  name           TEXT,
  file_path      TEXT,
  properties     TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind         ON nodes (kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified    ON nodes (qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file         ON nodes (file_path);
-- Migration: idx_nodes_name was an exact duplicate of idx_nodes_qualified.
DROP INDEX IF EXISTS idx_nodes_name;

CREATE TABLE IF NOT EXISTS edges (
  source     TEXT NOT NULL,
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source, target, kind),
  FOREIGN KEY (source) REFERENCES nodes (id) ON DELETE CASCADE,
  FOREIGN KEY (target) REFERENCES nodes (id) ON DELETE CASCADE
);
-- Traversals always filter on one endpoint *and* an edge-kind list, so the
-- composite indexes replace the single-column ones of schema version 1.
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges (source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges (target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_kind        ON edges (kind);

CREATE TABLE IF NOT EXISTS crawl_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Full-text index over node names. External-content FTS5 keeps the text in
 * `nodes` (no duplication) and triggers keep the index in sync with every
 * write path, including cascading deletes.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id,
  qualified_name,
  name,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts (rowid, id, qualified_name, name)
  VALUES (new.rowid, new.id, new.qualified_name, COALESCE(new.name, ''));
END;
CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, id, qualified_name, name)
  VALUES ('delete', old.rowid, old.id, old.qualified_name, COALESCE(old.name, ''));
END;
CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts (nodes_fts, rowid, id, qualified_name, name)
  VALUES ('delete', old.rowid, old.id, old.qualified_name, COALESCE(old.name, ''));
  INSERT INTO nodes_fts (rowid, id, qualified_name, name)
  VALUES (new.rowid, new.id, new.qualified_name, COALESCE(new.name, ''));
END;
`;

/** Per-file crawl manifest: change detection plus the cached parse result. */
const FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  language   TEXT NOT NULL,
  summary    TEXT,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

/** Indexes that match the shapes the query layer actually asks for. */
const QUERY_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nodes_name_col    ON nodes (name);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges (source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges (target, kind);
-- find_entry_points used to scan every node through json_extract().
CREATE INDEX IF NOT EXISTS idx_nodes_entry_point
  ON nodes (json_extract(properties, '$.entryPoint'));
`;

/**
 * Bumped whenever a migration below changes the on-disk shape. Databases
 * created before versioning was introduced are stamped at this version when
 * first opened, because the schema is already idempotent.
 */
const SCHEMA_VERSION = 2;

interface Migration {
  version: number;
  up(db: Database.Database): void;
}

/** Ordered, idempotent upgrades. Append new entries; never rewrite history. */
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db) {
      db.exec(FILES_SCHEMA);
      const columns = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "name")) {
        db.exec("ALTER TABLE nodes ADD COLUMN name TEXT");
      }
      // Backfill the denormalised display name for rows written by v1.
      const pending = db
        .prepare("SELECT rowid AS rid, qualified_name AS qn FROM nodes WHERE name IS NULL")
        .all() as { rid: number; qn: string }[];
      if (pending.length > 0) {
        const update = db.prepare("UPDATE nodes SET name = ? WHERE rowid = ?");
        for (const row of pending) update.run(displayName(row.qn), row.rid);
      }
      db.exec("DROP INDEX IF EXISTS idx_edges_source; DROP INDEX IF EXISTS idx_edges_target;");
      db.exec(QUERY_INDEXES);
      db.exec(FTS_SCHEMA);
      // Populate the FTS index from existing content (no-op on a fresh DB).
      db.exec("INSERT INTO nodes_fts (nodes_fts) VALUES ('rebuild')");
    },
  },
];

/** The short display name: the last `#` or `.` segment of a qualified name. */
function displayName(qualifiedName: string): string {
  const hash = qualifiedName.lastIndexOf("#");
  if (hash >= 0) return qualifiedName.slice(hash + 1);
  const dot = qualifiedName.lastIndexOf(".");
  return dot >= 0 ? qualifiedName.slice(dot + 1) : qualifiedName;
}

export interface StoreStats {
  nodes: number;
  edges: number;
  files: number;
  lastCrawl: string | null;
}

/** One row of the crawl manifest, used to skip unchanged files. */
export interface FileRecord {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  language: string;
  /** Serialised `ParsedFile` (see `parser/cache.ts`), when one was stored. */
  summary: string | null;
}

export class GraphStore {
  readonly db: Database.Database;

  /** Default cap on transitive traversal depth (config override). */
  readonly maxDepth: number;
  /** Default result cap for list queries (config override). */
  readonly defaultLimit: number;

  private insertNodeStmt: Database.Statement;
  private insertEdgeStmt: Database.Statement;
  private deleteFileNodesStmt: Database.Statement;
  private updateMetaStmt: Database.Statement;

  constructor(dbPath: string, options: { maxDepth?: number; defaultLimit?: number } = {}) {
    this.maxDepth = options.maxDepth ?? 10;
    this.defaultLimit = options.defaultLimit ?? 50;
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    // A project database can be shared by the CLI and a plugin server: wait for
    // the write lock instead of failing the call with SQLITE_BUSY.
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    try {
      // Migrations may add columns the prepared statements below depend on, so
      // they must run first. Only the meta statement is safe before them.
      this.updateMetaStmt = this.db.prepare(
        `INSERT INTO crawl_meta (key, value) VALUES (@key, @value)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      );
      this.migrate();

      this.insertNodeStmt = this.db.prepare(`
        INSERT INTO nodes (id, kind, qualified_name, name, file_path, properties)
        VALUES (@id, @kind, @qualifiedName, @name, @filePath, @properties)
        ON CONFLICT (id) DO UPDATE SET
          kind = excluded.kind,
          qualified_name = excluded.qualified_name,
          name = excluded.name,
          file_path = excluded.file_path,
          properties = excluded.properties,
          updated_at = unixepoch()
      `);

      this.insertEdgeStmt = this.db.prepare(`
        INSERT INTO edges (source, target, kind, properties)
        VALUES (@source, @target, @kind, @properties)
        ON CONFLICT (source, target, kind) DO UPDATE SET
          properties = excluded.properties,
          created_at = unixepoch()
      `);

      this.deleteFileNodesStmt = this.db.prepare("DELETE FROM nodes WHERE file_path = ?");
    } catch (err) {
      // A failed open must not keep the SQLite handle (and its WAL files)
      // alive, or the offending database cannot even be deleted by the user.
      this.db.close();
      throw err;
    }
  }

  /**
   * Bring the database up to SCHEMA_VERSION, or fail loudly when it was
   * written by a newer build. Never silently tolerate an unknown shape.
   */
  private migrate(): void {
    const stored = this.getMeta("schema_version");
    const found = stored === null ? 0 : Number.parseInt(stored, 10);
    if (!Number.isInteger(found) || found < 0) {
      throw new Error(
        `index has an unreadable schema_version (${JSON.stringify(stored)}); ` +
          `run clear_index and crawl again`
      );
    }
    if (found > SCHEMA_VERSION) {
      throw new Error(
        `index schema version ${found} is newer than this build supports (${SCHEMA_VERSION}); ` +
          `upgrade code-crawler or point CODECRAWLER_DB at a separate database`
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= found) continue;
      migration.up(this.db);
      this.setMeta("schema_version", String(migration.version));
    }
    this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  /** Schema version stamped into this database. */
  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Persist a node. Idempotent: re-indexing an existing symbol just updates it.
   */
  upsertNode(node: GraphNode): void {
    this.insertNodeStmt.run({
      id: node.id,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      name: node.properties.name ?? displayName(node.qualifiedName),
      filePath: node.filePath,
      properties: JSON.stringify(node.properties),
    });
  }

  /**
   * Persist multiple nodes in a single transaction for batch ingestion.
   */
  upsertNodes(nodes: GraphNode[]): void {
    if (nodes.length === 0) return;
    const tx = this.db.transaction((items: GraphNode[]) => {
      for (const n of items) this.upsertNode(n);
    });
    tx(nodes);
  }

  /**
   * Persist an edge. Both endpoints must exist (FK enforced).
   */
  upsertEdge(edge: GraphEdge): void {
    this.insertEdgeStmt.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      properties: JSON.stringify(edge.properties),
    });
  }

  upsertEdges(edges: GraphEdge[]): void {
    if (edges.length === 0) return;
    const tx = this.db.transaction((items: GraphEdge[]) => {
      for (const e of items) this.upsertEdge(e);
    });
    tx(edges);
  }

  getNode(id: string): GraphNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToNode(row) : null;
  }

  /**
   * Look up a node by qualified name. Qualified names are not unique across
   * kinds (e.g. a constructor and its class), so order deterministically
   * instead of letting SQLite pick an arbitrary row.
   */
  getNodeByQualifiedName(qn: string): GraphNode | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE qualified_name = ? ORDER BY kind, id LIMIT 1")
      .get(qn) as Row | undefined;
    return row ? rowToNode(row) : null;
  }

  /** All nodes originating from one source file (for reindex + stats). */
  getFileNodes(filePath: string): GraphNode[] {
    const rows = this.db.prepare("SELECT * FROM nodes WHERE file_path = ?").all(filePath) as Row[];
    return rows.map(rowToNode);
  }

  /**
   * Remove every node declared in a file, plus their incident edges
   * (cascade). Nodes referenced by the file but declared elsewhere survive.
   */
  removeFile(filePath: string): void {
    this.deleteFileNodesStmt.run(filePath);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  /** Crawl manifest of every indexed file, keyed by absolute path. */
  listFileRecords(): Map<string, FileRecord> {
    const rows = this.db
      .prepare("SELECT path, size, mtime_ms, sha256, language, summary FROM files")
      .all() as {
      path: string;
      size: number;
      mtime_ms: number;
      sha256: string;
      language: string;
      summary: string | null;
    }[];
    const out = new Map<string, FileRecord>();
    for (const row of rows) {
      out.set(row.path, {
        path: row.path,
        size: row.size,
        mtimeMs: row.mtime_ms,
        sha256: row.sha256,
        language: row.language,
        summary: row.summary,
      });
    }
    return out;
  }

  putFileRecord(record: FileRecord): void {
    this.db
      .prepare(
        `INSERT INTO files (path, size, mtime_ms, sha256, language, summary, indexed_at)
         VALUES (@path, @size, @mtimeMs, @sha256, @language, @summary, unixepoch())
         ON CONFLICT (path) DO UPDATE SET
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           sha256 = excluded.sha256,
           language = excluded.language,
           summary = excluded.summary,
           indexed_at = unixepoch()`
      )
      .run({
        path: record.path,
        size: record.size,
        mtimeMs: record.mtimeMs,
        sha256: record.sha256,
        language: record.language,
        summary: record.summary,
      });
  }

  /**
   * Flag a symbol as a framework-invoked entry point without rewriting the
   * rest of its properties. Used for symbols in files that were not re-parsed,
   * whose persisted row still needs the cross-file route annotation.
   */
  markEntryPoint(id: string, kind: string, detail: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE nodes
         SET properties = json_set(properties, '$.entryPoint', json('true'),
                                   '$.entryPointKind', ?, '$.entryPointDetail', ?),
             updated_at = unixepoch()
         WHERE id = ? AND COALESCE(json_extract(properties, '$.entryPoint'), 0) <> 1`
      )
      .run(kind, detail, id);
    return info.changes > 0;
  }

  /**
   * Delete file-less shared nodes (package, annotation, external symbol) that
   * no longer participate in any edge. Returns the number of nodes removed.
   * Call inside the crawl transaction so pruning cannot partially apply.
   */
  pruneOrphanNodes(): number {
    const info = this.db
      .prepare(
        `DELETE FROM nodes
         WHERE file_path IS NULL
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source = nodes.id)
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = nodes.id)`
      )
      .run();
    return info.changes;
  }

  /**
   * Rebuild the graph for a single file: drop its symbols and edges, then
   * re-ingest. Call inside a caller-supplied transaction when batching.
   */
  replaceFile(filePath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const tx = this.db.transaction((fp: string, ns: GraphNode[], es: GraphEdge[]) => {
      // Defer FK checks to commit (cross-file edges may reference nodes from
      // other files that are inserted later in the same batch).
      this.db.pragma("defer_foreign_keys = ON");
      const oldIds = (
        this.db.prepare("SELECT id FROM nodes WHERE file_path = ?").all(fp) as { id: string }[]
      ).map((r) => r.id);
      const newIds = new Set(ns.map((n) => n.id));

      // Drop edges owned by this file (their replacements arrive below).
      const deleteFileEdges = this.db.prepare(
        "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)"
      );
      deleteFileEdges.run(fp);

      // Sweep nodes that no longer exist in the file. Cascading deletes
      // remove their incident edges (including incoming cross-file CALLS,
      // which correctly become unresolvable again).
      const sweep = this.db.prepare("DELETE FROM nodes WHERE id = ?");
      for (const id of oldIds) {
        if (!newIds.has(id)) sweep.run(id);
      }

      this.upsertNodes(ns);
      this.upsertEdges(es);
    });
    tx(filePath, nodes, edges);
  }

  /**
   * Delete every edge of the given kinds. Project-wide derived edges
   * (DYNAMIC_DISPATCH / ADVISES) are rebuilt from scratch on each crawl so
   * removing an override or advice method cannot leave stale edges behind.
   */
  deleteEdgesByKind(kinds: EdgeKind[]): void {
    if (kinds.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM edges WHERE kind = ?");
    const tx = this.db.transaction(() => {
      for (const kind of kinds) stmt.run(kind);
    });
    tx();
  }

  /** Ensure every CALLS edge endpoint exists (e.g. phantom unknown symbols). */
  ensureNode(node: GraphNode): void {
    if (!this.getNode(node.id)) this.upsertNode(node);
  }

  setMeta(key: string, value: string): void {
    this.updateMetaStmt.run({ key, value });
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM crawl_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  stats(): StoreStats {
    const nodeRow = this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as {
      c: number;
    };
    const edgeRow = this.db.prepare("SELECT COUNT(*) AS c FROM edges").get() as {
      c: number;
    };
    const fileRow = this.db
      .prepare("SELECT COUNT(DISTINCT file_path) AS c FROM nodes WHERE file_path IS NOT NULL")
      .get() as { c: number };
    return {
      nodes: nodeRow.c,
      edges: edgeRow.c,
      files: fileRow.c,
      lastCrawl: this.getMeta("last_crawl_at"),
    };
  }

  clearAll(): void {
    const tx = this.db.transaction(() => {
      this.db.exec(
        "DELETE FROM edges; DELETE FROM nodes; DELETE FROM files; DELETE FROM crawl_meta;"
      );
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    });
    tx();
  }

  /** Run a function inside a transaction. */
  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(() => {
      // Defer FK enforcement to commit so cross-file edges can be inserted
      // before their target nodes exist (they are guaranteed by commit).
      this.db.pragma("defer_foreign_keys = ON");
      return fn();
    })();
  }

  /**
   * SQLite uses 0-based row/col; tree-sitter uses 0-based row but 1-based col.
   * Store and expose tree-sitter-compatible positions (0-based line) and let
   * the presentation layer add +1 where humans expect 1-based lines.
   */
  /**
   * Escape hatch for ad-hoc SQL. The row shape is the caller's contract, so
   * pass it as a type parameter instead of casting the result at every call.
   */
  raw<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}

interface Row {
  id: string;
  kind: NodeKind;
  qualified_name: string;
  file_path: string | null;
  properties: string;
}

function rowToNode(row: Row): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    properties: JSON.parse(row.properties) as NodeProperties,
  };
}

export type { EdgeKind, EdgeProperties };
