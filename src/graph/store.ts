import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  NodeProperties,
  EdgeProperties,
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
  file_path      TEXT,
  properties     TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind         ON nodes (kind);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified    ON nodes (qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_name         ON nodes (qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file         ON nodes (file_path);

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
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
CREATE INDEX IF NOT EXISTS idx_edges_kind   ON edges (kind);

CREATE TABLE IF NOT EXISTS crawl_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export interface StoreStats {
  nodes: number;
  edges: number;
  files: number;
  lastCrawl: string | null;
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
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    this.insertNodeStmt = this.db.prepare(`
      INSERT INTO nodes (id, kind, qualified_name, file_path, properties)
      VALUES (@id, @kind, @qualifiedName, @filePath, @properties)
      ON CONFLICT (id) DO UPDATE SET
        kind = excluded.kind,
        qualified_name = excluded.qualified_name,
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

    this.deleteFileNodesStmt = this.db.prepare(
      "DELETE FROM nodes WHERE file_path = ?"
    );
    this.updateMetaStmt = this.db.prepare(
      `INSERT INTO crawl_meta (key, value) VALUES (@key, @value)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    );
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
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodeByQualifiedName(qn: string): GraphNode | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE qualified_name = ? LIMIT 1")
      .get(qn) as Row | undefined;
    return row ? rowToNode(row) : null;
  }

  /** All nodes originating from one source file (for reindex + stats). */
  getFileNodes(filePath: string): GraphNode[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE file_path = ?")
      .all(filePath) as Row[];
    return rows.map(rowToNode);
  }

  /**
   * Remove every node declared in a file, plus their incident edges
   * (cascade). Nodes referenced by the file but declared elsewhere survive.
   */
  removeFile(filePath: string): void {
    this.deleteFileNodesStmt.run(filePath);
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

  /** Ensure every CALLS edge endpoint exists (e.g. phantom unknown symbols). */
  ensureNode(node: GraphNode): void {
    if (!this.getNode(node.id)) this.upsertNode(node);
  }

  setMeta(key: string, value: string): void {
    this.updateMetaStmt.run({ key, value });
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM crawl_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
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
      this.db.exec("DELETE FROM edges; DELETE FROM nodes; DELETE FROM crawl_meta;");
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
  raw(sql: string, ...params: unknown[]): unknown {
    return this.db.prepare(sql).all(...params);
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
