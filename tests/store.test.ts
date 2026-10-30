import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { methodNodeId, fieldNodeId } from "../src/graph/schema.js";
import type { GraphNode, GraphEdge } from "../src/graph/schema.js";

function node(id: string, kind: GraphNode["kind"] = "method", filePath = "/tmp/A.java"): GraphNode {
  return { id, kind, qualifiedName: id, filePath, properties: {} };
}

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:");
  store.clearAll();
});

describe("GraphStore", () => {
  it("upserts nodes idempotently", () => {
    store.upsertNode(node("com.acme.Foo#a"));
    store.upsertNode(node("com.acme.Foo#a"));
    expect(store.stats().nodes).toBe(1);
  });

  it("upserts edges with FK enforcement", () => {
    store.upsertNode(node("com.acme.Foo#a"));
    store.upsertNode(node("com.acme.Foo#b"));
    const edge: GraphEdge = {
      source: "com.acme.Foo#a",
      target: "com.acme.Foo#b",
      kind: "CALLS",
      properties: { resolved: true, line: 3 },
    };
    store.upsertEdge(edge);
    const rows = store.raw("SELECT COUNT(*) AS c FROM edges");
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it("rejects edges to missing nodes", () => {
    store.upsertNode(node("com.acme.Foo#a"));
    expect(() =>
      store.upsertEdge({
        source: "com.acme.Foo#a",
        target: "missing",
        kind: "CALLS",
        properties: {},
      })
    ).toThrow(/FOREIGN KEY/);
  });

  it("replaces a file scoped graph and keeps cross-file edges to survivors", () => {
    store.upsertNode(node("com.acme.Foo#run", "method", "/tmp/Foo.java"));
    store.upsertNode(node("com.acme.Foo#helper", "method", "/tmp/Foo.java"));
    store.upsertNode(node("com.acme.Bar#main", "method", "/tmp/Bar.java"));
    store.upsertEdge({
      source: "com.acme.Bar#main",
      target: "com.acme.Foo#run",
      kind: "CALLS",
      properties: {},
    });

    // Reindex Foo.java: helper removed, run survives.
    store.replaceFile(
      "/tmp/Foo.java",
      [node("com.acme.Foo#run", "method", "/tmp/Foo.java")],
      []
    );

    expect(store.getNode("com.acme.Foo#helper")).toBeNull();
    // Cross-file edge Bar#main -> Foo#run survives.
    const edge = store.raw("SELECT source, target FROM edges WHERE kind='CALLS'");
    expect(edge).toEqual([{ source: "com.acme.Bar#main", target: "com.acme.Foo#run" }]);
  });

  it("round-trips node properties as JSON", () => {
    store.upsertNode({
      id: "com.acme.Foo#run",
      kind: "method",
      qualifiedName: "com.acme.Foo#run",
      filePath: "/tmp/Foo.java",
      properties: { name: "run", signature: "(int, String)", modifiers: ["public"] },
    });
    const n = store.getNode("com.acme.Foo#run");
    expect(n?.properties).toMatchObject({
      name: "run",
      modifiers: ["public"],
    });
  });

  it("clears all data", () => {
    store.upsertNode(node("com.acme.Foo#a"));
    store.setMeta("last_crawl_at", "now");
    store.clearAll();
    expect(store.stats()).toMatchObject({ nodes: 0, edges: 0 });
    expect(store.getMeta("last_crawl_at")).toBeNull();
  });

  it("resolves duplicate qualified names deterministically", () => {
    store.upsertNode({
      id: "z#run",
      kind: "method",
      qualifiedName: "com.acme.Shared#run",
      filePath: "/tmp/Z.java",
      properties: {},
    });
    store.upsertNode({
      id: "a#run",
      kind: "method",
      qualifiedName: "com.acme.Shared#run",
      filePath: "/tmp/A.java",
      properties: {},
    });

    expect(store.getNodeByQualifiedName("com.acme.Shared#run")?.id).toBe("a#run");
  });

  it("drops the legacy duplicate qualified-name index on open", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-store-"));
    const dbPath = path.join(tmp, "index.db");
    try {
      let legacy = new GraphStore(dbPath);
      legacy.db.exec("CREATE INDEX idx_nodes_name ON nodes (qualified_name)");
      legacy.close();

      const upgraded = new GraphStore(dbPath);
      const indexes = upgraded.raw(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_nodes_name','idx_nodes_qualified')"
      ) as { name: string }[];
      upgraded.close();

      expect(indexes.map((i) => i.name)).toEqual(["idx_nodes_qualified"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prunes orphan file-less nodes and keeps referenced ones", () => {
    store.upsertNode(node("com.acme.Foo#run"));
    store.upsertNode({
      id: "com.acme.orphan",
      kind: "package",
      qualifiedName: "com.acme.orphan",
      filePath: null,
      properties: {},
    });
    store.upsertNode({
      id: "com.acme.used",
      kind: "package",
      qualifiedName: "com.acme.used",
      filePath: null,
      properties: {},
    });
    store.upsertEdge({
      source: "com.acme.Foo#run",
      target: "com.acme.used",
      kind: "DECLARED_IN",
      properties: {},
    });

    expect(store.pruneOrphanNodes()).toBe(1);
    expect(store.getNode("com.acme.orphan")).toBeNull();
    expect(store.getNode("com.acme.used")).not.toBeNull();
    // File-scoped nodes are owned by file reindexing, never by orphan GC.
    expect(store.getNode("com.acme.Foo#run")).not.toBeNull();
  });

  it("exposes field and method node id helpers", () => {
    expect(methodNodeId("com.acme.Foo", "run")).toBe("com.acme.Foo#run");
    expect(fieldNodeId("com.acme.Foo", "repo")).toBe("com.acme.Foo$repo");
  });
});

describe("schema versioning", () => {
  function tempDb(name: string): { file: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-schema-"));
    return {
      file: path.join(dir, name),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("stamps the current schema version on a new database", () => {
    expect(store.getMeta("schema_version")).toBe(String(store.schemaVersion));
  });

  it("re-stamps the schema version after clearAll", () => {
    store.clearAll();
    expect(store.getMeta("schema_version")).toBe(String(store.schemaVersion));
  });

  it("reopens a database written by the same schema version", () => {
    const { file, cleanup } = tempDb("same.db");
    try {
      const first = new GraphStore(file);
      const version = first.schemaVersion;
      first.close();
      const second = new GraphStore(file);
      expect(second.getMeta("schema_version")).toBe(String(version));
      second.close();
    } finally {
      cleanup();
    }
  });

  it("refuses a database written by a newer build", () => {
    const { file, cleanup } = tempDb("newer.db");
    try {
      const first = new GraphStore(file);
      const version = first.schemaVersion;
      first.setMeta("schema_version", String(version + 1));
      first.close();

      expect(() => new GraphStore(file)).toThrow(/newer than this build/);
    } finally {
      cleanup();
    }
  });

  it("refuses an unreadable schema version", () => {
    const { file, cleanup } = tempDb("broken.db");
    try {
      const first = new GraphStore(file);
      first.setMeta("schema_version", "banana");
      first.close();

      expect(() => new GraphStore(file)).toThrow(/unreadable schema_version/);
    } finally {
      cleanup();
    }
  });
});
