import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { applyBudget, estimateTokens, pageMeta } from "../src/graph/budget.js";
import {
  explainSymbol,
  exportGraph,
  findCycles,
  findUnresolved,
  impactAnalysis,
  unresolvedForNode,
} from "../src/graph/insights.js";
import type { EdgeKind, GraphEdge } from "../src/graph/schema.js";
import { methodNodeId, unknownNodeId } from "../src/graph/schema.js";
import { GraphStore } from "../src/graph/store.js";

const JAVA = path.join(__dirname, "fixtures", "java", "sample");
const CYCLES = path.join(__dirname, "fixtures", "java", "cycles");

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

afterEach(() => {
  store.close();
});

function addType(name: string, kind: "class" | "interface" = "class", props = {}): string {
  store.upsertNode({
    id: name,
    kind,
    qualifiedName: name,
    filePath: `/src/${name.split(".").pop()}.java`,
    properties: { name: name.split(".").pop(), ...props },
  });
  return name;
}

function addMethod(type: string, name: string, props = {}): string {
  const id = methodNodeId(type, name);
  store.upsertNode({
    id,
    kind: "method",
    qualifiedName: id,
    filePath: `/src/${type.split(".").pop()}.java`,
    properties: { name, startLine: 0, ...props },
  });
  return id;
}

function addUnknown(label: string): string {
  const id = unknownNodeId(label);
  store.upsertNode({
    id,
    kind: "unknown_symbol",
    qualifiedName: label,
    filePath: null,
    properties: { name: label },
  });
  return id;
}

function edge(
  source: string,
  target: string,
  kind: EdgeKind = "CALLS",
  properties: Record<string, unknown> = { resolved: true, line: 1 }
): GraphEdge {
  return { source, target, kind, properties };
}

describe("findUnresolved", () => {
  beforeEach(() => {
    addType("com.acme.Svc");
    const run = addMethod("com.acme.Svc", "run");
    addMethod("com.acme.Svc", "helper");
    store.upsertEdges([
      edge(run, addUnknown("System.out"), "CALLS", {
        resolved: false,
        line: 4,
        reason: 'could not infer receiver type: "System.out"',
      }),
      edge(run, addUnknown("dynamicThing"), "CALLS", {
        resolved: false,
        line: 9,
        reason: "unhandled dynamic receiver",
      }),
      edge(run, methodNodeId("com.acme.Svc", "helper")),
    ]);
  });

  it("groups unresolved calls by reason and strips the placeholder prefix", () => {
    const report = findUnresolved(store);
    expect(report.total).toBe(2);
    expect(report.calls.map((c) => c.targetLabel).sort()).toEqual(["System.out", "dynamicThing"]);
    expect(report.calls.every((c) => c.targetId.startsWith("__unknown__:"))).toBe(true);
    expect(report.byReason.map((r) => r.count)).toEqual([1, 1]);
    expect(report.scanTruncated).toBe(false);
  });

  it("filters by reason substring, case-insensitively", () => {
    const report = findUnresolved(store, { reason: "DYNAMIC" });
    expect(report.total).toBe(1);
    expect(report.calls[0]?.reason).toBe("unhandled dynamic receiver");
    expect(report.reasonFilter).toBe("DYNAMIC");
  });

  it("filters by caller kind", () => {
    expect(findUnresolved(store, { kind: "file" }).total).toBe(0);
    expect(findUnresolved(store, { kind: "method" }).total).toBe(2);
  });

  it("exposes unresolved edges of a single node", () => {
    const info = unresolvedForNode(store, methodNodeId("com.acme.Svc", "run"));
    expect(info?.outgoing).toHaveLength(2);
    expect(info?.incoming).toHaveLength(0);
  });

  it("returns undefined for a node with no unresolved edges", () => {
    expect(unresolvedForNode(store, methodNodeId("com.acme.Svc", "helper"))).toBeUndefined();
  });
});

describe("findUnresolved over the Java fixture", () => {
  it("reports the single unresolved call with its reason", async () => {
    await crawlProject(store, JAVA, loadConfig().excludeDirs, {});
    const report = findUnresolved(store);
    expect(report.total).toBe(1);
    const call = report.calls[0];
    expect(call?.caller.id).toBe("com.acme.Tracking#dispatch");
    expect(call?.targetLabel).toBe("System.out.println");
    expect(call?.reason).toContain("could not infer receiver type");
    expect(call?.line).toBe(10);
  });

  it("annotates the fixture's get_node target with its unresolved call", async () => {
    await crawlProject(store, JAVA, loadConfig().excludeDirs, {});
    const info = unresolvedForNode(store, "com.acme.Tracking#dispatch");
    expect(info?.outgoing.map((c) => c.targetLabel)).toEqual(["System.out.println"]);
  });
});

describe("impactAnalysis", () => {
  beforeEach(() => {
    addType("com.acme.Main");
    addType("com.acme.Order");
    addType("com.acme.Repository", "interface");
    addType("com.acme.JdbcRepository", "class");

    const main = addMethod("com.acme.Main", "main", { entryPoint: true, entryPointKind: "cli" });
    const place = addMethod("com.acme.Order", "place");
    const save = addMethod("com.acme.Repository", "save");
    addMethod("com.acme.JdbcRepository", "save");

    store.upsertNode({
      id: "module:app.api",
      kind: "module",
      qualifiedName: "module:app.api",
      filePath: "/src/app/api.py",
      properties: { name: "app.api" },
    });

    store.upsertEdges([
      edge(main, place),
      edge(place, save),
      edge("com.acme.JdbcRepository", "com.acme.Repository", "IMPLEMENTS"),
      edge("module:app.api", save, "ROUTES", {
        httpMethod: "POST",
        path: "/orders",
        framework: "router",
        line: 3,
      }),
    ]);
  });

  it("bundles callers, entry points, routes and implementations", () => {
    const result = impactAnalysis(store, "com.acme.Repository#save");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.summary.directCallers).toBe(1);
    expect(result.summary.totalCallers).toBe(2);
    expect(result.callers.map((c) => c.caller.id).sort()).toEqual([
      "com.acme.Main#main",
      "com.acme.Order#place",
    ]);
    expect(result.entryPoints.map((e) => e.entryPointKind)).toEqual(["cli"]);
    expect(result.entryPoints[0]?.viaDepth).toBe(2);
    expect(result.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["POST /orders"]);
    expect(result.implementations.map((i) => i.type.id)).toEqual(["com.acme.JdbcRepository"]);
    expect(result.summary.risk).toBe("high");
    expect(result.affectedFiles.length).toBeGreaterThan(1);
  });

  it("maps overrides when analysing a method rather than its type", () => {
    const result = impactAnalysis(store, "com.acme.Repository#save");
    expect(result?.implementations[0]?.method?.id).toBe("com.acme.JdbcRepository#save");
  });

  it("bands risk lower when no entry point reaches the symbol", () => {
    addMethod("com.acme.Lonely", "call");
    addMethod("com.acme.Lonely", "target");
    store.upsertEdge(
      edge(methodNodeId("com.acme.Lonely", "call"), methodNodeId("com.acme.Lonely", "target"))
    );
    const result = impactAnalysis(store, "com.acme.Lonely#target");
    expect(result?.summary.risk).toBe("medium");
  });

  it("returns null for an unknown symbol", () => {
    expect(impactAnalysis(store, "com.acme.Nope")).toBeNull();
  });
});

describe("explainSymbol", () => {
  beforeEach(() => {
    addType("com.acme.Ctrl", "class");
    addType("@Controller", "annotation", { name: "Controller" });
    const handle = addMethod("com.acme.Ctrl", "handle", { startLine: 42 });
    const go = addMethod("com.acme.Caller", "go");
    store.upsertEdges([
      edge("com.acme.Ctrl", "@Controller", "ANNOTATED_WITH", {
        line: 0,
        arguments: [],
      }),
      edge("com.acme.Ctrl", handle, "CONTAINS", { line: 2 }),
      edge(go, handle),
    ]);
  });

  it("collects members, decorators, callers and callees in one pass", () => {
    const result = explainSymbol(store, "com.acme.Ctrl");
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.symbol.id).toBe("com.acme.Ctrl");
    expect(result.decorators.map((d) => d.name)).toEqual(["Controller"]);
    expect(result.members.map((m) => m.symbol.id)).toEqual(["com.acme.Ctrl#handle"]);
    expect(result.members[0]?.line).toBe(42);
    expect(result.summary.members).toBe(1);
  });

  it("includes reverse callers of a member", () => {
    const result = explainSymbol(store, "com.acme.Ctrl#handle");
    expect(result?.callers.map((c) => c.caller.id)).toEqual(["com.acme.Caller#go"]);
  });

  it("returns null for an unknown symbol", () => {
    expect(explainSymbol(store, "com.acme.Nope")).toBeNull();
  });
});

describe("findCycles", () => {
  it("reports the mutual cycle and direct recursion in the cycles fixture", async () => {
    await crawlProject(store, CYCLES, loadConfig().excludeDirs, {});
    const report = findCycles(store);

    expect(report.cycleCount).toBe(1);
    const cycle = report.cycles[0];
    expect(cycle?.size).toBe(3);
    expect(cycle?.members.map((m) => m.id)).toEqual([
      "com.acme.cycles.Tangle#alpha",
      "com.acme.cycles.Tangle#beta",
      "com.acme.cycles.Tangle#gamma",
    ]);
    // The sample is a closed walk: it starts and ends at the same symbol.
    expect(cycle?.sample[0]).toBe(cycle?.sample[cycle.sample.length - 1]);
    expect(new Set(cycle?.sample).size).toBe(3);

    expect(report.selfRecursive.map((s) => s.id)).toEqual(["com.acme.cycles.Tangle#loop"]);
  });

  it("reports no cycles in an acyclic graph", async () => {
    await crawlProject(store, JAVA, loadConfig().excludeDirs, {});
    const report = findCycles(store);
    expect(report.cycleCount).toBe(0);
    expect(report.selfRecursive).toEqual([]);
  });

  it("honours minSize", async () => {
    await crawlProject(store, CYCLES, loadConfig().excludeDirs, {});
    expect(findCycles(store, { minSize: 4 }).cycleCount).toBe(0);
    expect(findCycles(store, { minSize: 3 }).cycleCount).toBe(1);
  });
});

describe("exportGraph", () => {
  beforeEach(() => {
    addType("com.acme.A");
    addType("com.acme.B");
    const a = addMethod("com.acme.A", "run");
    const b = addMethod("com.acme.B", "run");
    store.upsertEdge(edge(a, b));
  });

  it("renders a Mermaid diagram", () => {
    const result = exportGraph(store, { symbol: "com.acme.A#run", radius: 2 });
    expect(result).not.toBeNull();
    expect(result?.format).toBe("mermaid");
    expect(result?.diagram).toContain("graph LR");
    expect(result?.diagram).toContain("com.acme.A#run");
    expect(result?.diagram).toContain("|CALLS|");
    expect(result?.nodeCount).toBeGreaterThan(1);
  });

  it("renders DOT when asked", () => {
    const result = exportGraph(store, { symbol: "com.acme.A#run", format: "dot", direction: "TB" });
    expect(result?.diagram.startsWith("digraph codecrawler {")).toBe(true);
    expect(result?.diagram).toContain("rankdir=TB;");
    expect(result?.diagram).toContain("->");
  });

  it("returns null for an unknown center symbol", () => {
    expect(exportGraph(store, { symbol: "com.acme.Nope" })).toBeNull();
  });
});

describe("applyBudget", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i, padding: "x".repeat(40) }));

  it("returns every item when no budget is supplied", () => {
    const page = applyBudget(items);
    expect(page.items).toHaveLength(10);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("cuts the list and points at the next cursor", () => {
    const page = applyBudget(items, { maxTokens: 60 });
    expect(page.returnedCount).toBeLessThan(10);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBe(page.returnedCount);

    const next = applyBudget(items, { cursor: page.nextCursor, maxTokens: 60 });
    expect(next.items[0]?.id).toBe(page.nextCursor);
  });

  it("always returns at least one item so a page cannot stall", () => {
    const page = applyBudget(items, { maxTokens: 1 });
    expect(page.items).toHaveLength(1);
  });

  it("walks the whole list without duplicates", () => {
    const seen: number[] = [];
    let cursor: number | undefined = 0;
    for (let guard = 0; guard < 100 && cursor !== undefined; guard++) {
      const page = applyBudget(items, { cursor, maxTokens: 50 });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(items.map((i) => i.id));
  });

  it("estimates tokens from the JSON length", () => {
    expect(estimateTokens({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 4));
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("exposes page metadata without the items", () => {
    const meta = pageMeta(applyBudget(items, { maxTokens: 60 }));
    expect(meta).not.toHaveProperty("items");
    expect(meta.totalCount).toBe(10);
  });
});
