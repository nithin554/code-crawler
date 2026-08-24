import { describe, it, expect, beforeEach } from "vitest";
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

  it("exposes field and method node id helpers", () => {
    expect(methodNodeId("com.acme.Foo", "run")).toBe("com.acme.Foo#run");
    expect(fieldNodeId("com.acme.Foo", "repo")).toBe("com.acme.Foo$repo");
  });
});
