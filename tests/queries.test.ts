import { describe, it, expect, beforeEach } from "vitest";
import { GraphStore } from "../src/graph/store.js";
import { methodNodeId } from "../src/graph/schema.js";
import {
  getCallers,
  getCallees,
  tracePath,
  getSubgraph,
  searchSymbols,
} from "../src/graph/queries.js";
import type { GraphEdge } from "../src/graph/schema.js";

let store: GraphStore;

function addMethod(type: string, name: string, file: string): string {
  const id = methodNodeId(type, name);
  store.upsertNode({ id, kind: "method", qualifiedName: id, filePath: file, properties: { name } });
  return id;
}

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  // com.acme.Main#main -> OrderService#place -> OrderRepository#create
  //                  \-> CustomerService#find
  //                  \-> ShippingService#ship -> Tracking#dispatch
  const f = (t: string) => `/tmp/${t.split(".").pop()}.java`;
  addMethod("com.acme.Main", "main", f("com.acme.Main"));
  addMethod("com.acme.OrderService", "place", f("com.acme.OrderService"));
  addMethod("com.acme.OrderRepository", "create", f("com.acme.OrderRepository"));
  addMethod("com.acme.CustomerService", "find", f("com.acme.CustomerService"));
  addMethod("com.acme.ShippingService", "ship", f("com.acme.ShippingService"));
  addMethod("com.acme.Tracking", "dispatch", f("com.acme.Tracking"));

  const E = (src: string, tgt: string): GraphEdge => ({
    source: src,
    target: tgt,
    kind: "CALLS",
    properties: { resolved: true, line: 1 },
  });
  store.upsertEdges([
    E(methodNodeId("com.acme.Main", "main"), methodNodeId("com.acme.OrderService", "place")),
    E(methodNodeId("com.acme.Main", "main"), methodNodeId("com.acme.CustomerService", "find")),
    E(methodNodeId("com.acme.Main", "main"), methodNodeId("com.acme.ShippingService", "ship")),
    E(methodNodeId("com.acme.OrderService", "place"), methodNodeId("com.acme.OrderRepository", "create")),
    E(methodNodeId("com.acme.ShippingService", "ship"), methodNodeId("com.acme.Tracking", "dispatch")),
  ]);
});

describe("getCallers", () => {
  it("returns direct callers", () => {
    const r = getCallers(store, "com.acme.OrderRepository#create", { transitive: false });
    expect(r?.callers.map((c) => c.caller.qualifiedName)).toEqual(["com.acme.OrderService#place"]);
  });

  it("returns transitive callers with depth", () => {
    const r = getCallers(store, "com.acme.OrderRepository#create", { transitive: true });
    expect(r?.callers).toEqual([
      expect.objectContaining({ depth: 1, caller: expect.objectContaining({ qualifiedName: "com.acme.OrderService#place" }) }),
      expect.objectContaining({ depth: 2, caller: expect.objectContaining({ qualifiedName: "com.acme.Main#main" }) }),
    ]);
  });

  it("returns null for unknown symbols", () => {
    expect(getCallers(store, "missing#x")).toBeNull();
  });
});

describe("getCallees", () => {
  it("returns direct callees", () => {
    const r = getCallees(store, "com.acme.Main#main", { transitive: false });
    expect(r?.callees.map((c) => c.callee.qualifiedName).sort()).toEqual([
      "com.acme.CustomerService#find",
      "com.acme.OrderService#place",
      "com.acme.ShippingService#ship",
    ]);
  });

  it("returns transitive callees with depth", () => {
    const r = getCallees(store, "com.acme.Main#main", { transitive: true });
    const names = r?.callees.map((c) => `${c.depth}:${c.callee.qualifiedName}`).sort();
    expect(names).toContain("2:com.acme.OrderRepository#create");
    expect(names).toContain("2:com.acme.Tracking#dispatch");
  });
});

describe("tracePath", () => {
  it("finds the shortest call path", () => {
    const paths = tracePath(store, "com.acme.Main#main", "com.acme.Tracking#dispatch");
    expect(paths?.[0]?.path).toEqual([
      "com.acme.Main#main",
      "com.acme.ShippingService#ship",
      "com.acme.Tracking#dispatch",
    ]);
  });

  it("returns empty for unreachable symbols", () => {
    const paths = tracePath(store, "com.acme.CustomerService#find", "com.acme.Main#main");
    expect(paths).toEqual([]);
  });

  it("returns null when either endpoint is unknown", () => {
    expect(tracePath(store, "missing#x", "com.acme.Main#main")).toBeNull();
  });
});

describe("getSubgraph", () => {
  it("returns the neighborhood around a symbol", () => {
    const r = getSubgraph(store, "com.acme.Main#main", { radius: 1 });
    const ids = r.nodes.map((n) => n.qualifiedName);
    expect(ids).toContain("com.acme.OrderService#place");
    expect(ids).toContain("com.acme.ShippingService#ship");
    expect(r.edges.some((e) => e.source === "com.acme.Main#main")).toBe(true);
  });

  it("returns center null for unknown symbols", () => {
    expect(getSubgraph(store, "nope#x").center).toBeNull();
  });
});

describe("searchSymbols", () => {
  it("finds by substring", () => {
    const r = searchSymbols(store, "place", {});
    expect(r.map((s) => s.qualifiedName)).toEqual(["com.acme.OrderService#place"]);
  });

  it("ranks exact qualified-name matches first", () => {
    const r = searchSymbols(store, "com.acme.Main#main", {});
    expect(r[0]?.qualifiedName).toBe("com.acme.Main#main");
  });

  it("filters by kind", () => {
    const r = searchSymbols(store, "main", { kind: "method" });
    expect(r.every((s) => s.kind === "method")).toBe(true);
  });
});
