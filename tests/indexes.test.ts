import { describe, it, expect, beforeEach } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { findEntryPoints, searchSymbols } from "../src/graph/queries.js";

let store: GraphStore;

interface PlanRow {
  detail: string;
}

function plan(sql: string, ...params: unknown[]): string {
  return (store.raw(`EXPLAIN QUERY PLAN ${sql}`, ...params) as PlanRow[])
    .map((r) => r.detail)
    .join("\n");
}

/** Names of the indexes SQLite reports for a table. */
function indexes(table: string): string[] {
  const rows = store.raw(`PRAGMA index_list('${table}')`) as { name: string }[];
  return rows.map((r) => r.name);
}

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  for (let i = 0; i < 200; i++) {
    store.upsertNode({
      id: `com.acme.Type${i}#call`,
      kind: "method",
      qualifiedName: `com.acme.Type${i}#call`,
      filePath: `/tmp/T${i}.java`,
      properties: { name: "call", ...(i % 10 === 0 ? { entryPoint: true, entryPointKind: "http" } : {}) },
    });
  }
});

describe("query-shape indexes", () => {
  it("declares composite edge indexes for both directions", () => {
    const names = indexes("edges");
    expect(names).toContain("idx_edges_source_kind");
    expect(names).toContain("idx_edges_target_kind");
  });

  it("answers the caller lookup from the target index", () => {
    // Mirrors the direct-caller SQL in getCallers.
    const text = plan(
      `SELECT n.id FROM edges e JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind IN ('CALLS','DYNAMIC_DISPATCH')
       ORDER BY e.kind, e.source LIMIT 10`,
      "com.acme.Type1#call"
    );
    expect(text).toContain("idx_edges_target_kind");
  });

  it("answers the callee lookup from the source index", () => {
    // Mirrors the direct-callee SQL in getCallees.
    const text = plan(
      `SELECT n.id FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind IN ('CALLS','DYNAMIC_DISPATCH')
       ORDER BY e.kind, e.target LIMIT 10`,
      "com.acme.Type1#call"
    );
    expect(text).toContain("idx_edges_source_kind");
  });

  it("answers the entry-point scan from the expression index", () => {
    const text = plan(
      `SELECT n.id FROM nodes n WHERE json_extract(n.properties, '$.entryPoint') = 1 LIMIT 10`
    );
    expect(text).toContain("idx_nodes_entry_point");
    expect(text).not.toContain("SCAN n");
  });

  it("does not scan the nodes table for entry points", () => {
    expect(findEntryPoints(store, { limit: 5 }).length).toBe(5);
    const text = plan(
      `SELECT n.id FROM nodes n WHERE json_extract(n.properties, '$.entryPoint') = 1`
    );
    expect(text).toMatch(/USING INDEX idx_nodes_entry_point/);
  });

  it("serves symbol search from the full-text index", () => {
    expect(searchSymbols(store, "call", { limit: 3 }).length).toBe(3);
    const text = plan(
      `SELECT n.id FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH ? LIMIT 3`,
      `"call"*`
    );
    expect(text).toContain("VIRTUAL TABLE INDEX");
  });
});
