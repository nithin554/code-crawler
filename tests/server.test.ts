import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "sample");

let store: GraphStore;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  server = createServer(store, loadConfig());
  client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  store.close();
});

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`tool ${name} returned no text`);
  return JSON.parse(text) as T;
}

describe("MCP server tools", () => {
  it("exposes all 27 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "clear_index",
        "crawl_project",
        "explain_symbol",
        "export_graph",
        "find_annotated",
        "find_aspects",
        "find_cycles",
        "find_dead_code",
        "find_entry_points",
        "find_external_dependencies",
        "find_hotspots",
        "find_implementations",
        "find_injections",
        "find_reflections",
        "find_routes",
        "find_unresolved",
        "get_callers",
        "get_callees",
        "get_decorators",
        "get_node",
        "get_schema",
        "get_subgraph",
        "impact_analysis",
        "index_status",
        "search_symbols",
        "trace_execution",
        "trace_path",
      ].sort()
    );
  });

  it("crawl_project -> index_status round trip", async () => {
    const crawl = await callTool<{
      ok: boolean;
      filesParsed: number;
      resolvedCalls: number;
      unresolvedCalls: number;
    }>("crawl_project", { path: FIXTURES });
    expect(crawl.ok).toBe(true);
    expect(crawl.filesParsed).toBe(8);
    expect(crawl.resolvedCalls).toBe(15);
    expect(crawl.unresolvedCalls).toBe(1);

    const status = await callTool<{ nodes: number; edges: number }>("index_status");
    expect(status.nodes).toBe(39);
    expect(status.edges).toBe(61);
  });

  it("search_symbols finds methods", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ results: { qualifiedName: string }[] }>("search_symbols", {
      query: "place",
    });
    expect(r.results.map((x) => x.qualifiedName)).toEqual(["com.acme.OrderService#place"]);
  });

  it("get_callers returns transitive callers", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ callers: { depth: number; caller: { qualifiedName: string } }[] }>(
      "get_callers",
      { symbol: "com.acme.OrderRepository#create" }
    );
    expect(r.callers.map((c) => c.caller.qualifiedName)).toEqual([
      "com.acme.OrderService#place",
      "com.acme.Main#main",
    ]);
  });

  it("get_callees returns transitive callees", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ callees: { callee: { qualifiedName: string } }[] }>("get_callees", {
      symbol: "com.acme.Main#main",
    });
    const names = r.callees.map((c) => c.callee.qualifiedName);
    expect(names).toContain("com.acme.Tracking#dispatch");
    expect(names).toContain("com.acme.OrderRepository#create");
  });

  it("trace_path finds the Main -> Tracking path", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ paths: { path: string[] }[] }>("trace_path", {
      source: "com.acme.Main#main",
      target: "com.acme.Tracking#dispatch",
    });
    expect(r.paths[0]?.path).toEqual([
      "com.acme.Main#main",
      "com.acme.ShippingService#ship",
      "com.acme.Tracking#dispatch",
    ]);
  });

  it("get_subgraph returns a neighborhood", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ center: { qualifiedName: string }; nodeCount: number }>(
      "get_subgraph",
      {
        symbol: "com.acme.OrderService#place",
        radius: 1,
      }
    );
    expect(r.center.qualifiedName).toBe("com.acme.OrderService#place");
    expect(r.nodeCount).toBeGreaterThanOrEqual(5);
  });

  it("get_node converts to 1-based line numbers", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ kind: string; properties: { startLine: number } }>("get_node", {
      qualified_name: "com.acme.OrderService#place",
    });
    expect(r.kind).toBe("method");
    expect(r.properties.startLine).toBe(10); // 0-based 9 -> 1-based 10
  });

  it("returns suggestions for unknown symbols", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ error: string; suggestions: unknown[] }>("get_callers", {
      symbol: "com.acme.OrderService#plce",
    });
    expect(r.error).toMatch(/not found/);
    expect(Array.isArray(r.suggestions)).toBe(true);
  });

  it("get_schema describes the graph model", async () => {
    const r = await callTool<{ nodeKinds: string[]; edgeKinds: string[] }>("get_schema");
    expect(r.nodeKinds).toContain("method");
    expect(r.edgeKinds).toContain("CALLS");
  });

  it("clear_index wipes the graph", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    await callTool("clear_index");
    const status = await callTool<{ nodes: number; edges: number }>("index_status");
    expect(status.nodes).toBe(0);
    expect(status.edges).toBe(0);
  });
});

describe("MCP server P3 analysis tools", () => {
  it("find_unresolved reports the fixture's unresolved call", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{
      total: number;
      byReason: { reason: string; count: number }[];
      unresolved: { caller: { id: string }; target: string; line?: number }[];
    }>("find_unresolved");
    expect(r.total).toBe(1);
    expect(r.unresolved[0]?.caller.id).toBe("com.acme.Tracking#dispatch");
    expect(r.unresolved[0]?.target).toBe("System.out.println");
    expect(r.unresolved[0]?.line).toBe(11);
    expect(r.byReason[0]?.count).toBe(1);
  });

  it("get_node includes unresolved outgoing calls", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ unresolved?: { calls: { target: string }[] } }>("get_node", {
      qualified_name: "com.acme.Tracking#dispatch",
    });
    expect(r.unresolved?.calls.map((c) => c.target)).toEqual(["System.out.println"]);
  });

  it("omits the unresolved block when a node has none", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<Record<string, unknown>>("get_node", {
      qualified_name: "com.acme.Main#main",
    });
    expect(r).not.toHaveProperty("unresolved");
  });

  it("impact_analysis bundles risk, entry points and callers", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{
      summary: { risk: string; directCallers: number; totalCallers: number };
      entryPoints: { symbol: { id: string } }[];
    }>("impact_analysis", { symbol: "com.acme.OrderService#place" });
    expect(r.summary.totalCallers).toBe(1);
    expect(r.summary.risk).toBe("high");
    expect(r.entryPoints.map((e) => e.symbol.id)).toContain("com.acme.Main#main");
  });

  it("impact_analysis aggregates the callers of a type's members", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ summary: { totalCallers: number; risk: string } }>(
      "impact_analysis",
      {
        symbol: "com.acme.OrderService",
      }
    );
    expect(r.summary.totalCallers).toBeGreaterThan(0);
    expect(r.summary.risk).toBe("high");
  });

  it("impact_analysis returns an error for an unknown symbol", async () => {
    const r = await callTool<{ ok: boolean; error: string }>("impact_analysis", {
      symbol: "com.nope.X",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("com.nope.X");
  });

  it("explain_symbol lists members and decorators", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{
      symbol: { id: string };
      members: { symbol: { id: string } }[];
      summary: Record<string, number>;
    }>("explain_symbol", { symbol: "com.acme.OrderService" });
    expect(r.symbol.id).toBe("com.acme.OrderService");
    expect(r.members.map((m) => m.symbol.id)).toContain("com.acme.OrderService#place");
  });

  it("find_cycles reports no cycles in the acyclic fixture", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ cycleCount: number }>("find_cycles");
    expect(r.cycleCount).toBe(0);
  });

  it("export_graph renders Mermaid and DOT", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const mermaid = await callTool<{ diagram: string }>("export_graph", {
      symbol: "com.acme.Main#main",
      format: "mermaid",
    });
    expect(mermaid.diagram).toContain("graph LR");

    const dot = await callTool<{ diagram: string }>("export_graph", {
      symbol: "com.acme.Main#main",
      format: "dot",
    });
    expect(dot.diagram.startsWith("digraph")).toBe(true);
  });
});

describe("MCP server token budgeting", () => {
  it("keeps the unbudgeted payload shape unchanged", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<Record<string, unknown>>("find_entry_points");
    expect(r).toHaveProperty("entryPoints");
    expect(r).not.toHaveProperty("page");
  });

  it("adds page metadata and truncates when max_tokens is small", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const full = await callTool<{ hotspots: unknown[] }>("find_hotspots");
    expect(full.hotspots.length).toBeGreaterThan(1);

    const seen: unknown[] = [];
    let cursor: number | undefined = 0;
    let truncated = false;
    let pages = 0;
    while (pages < 100) {
      const page = await callTool<{
        hotspots: unknown[];
        page: { truncated: boolean; totalCount: number; nextCursor?: number };
      }>("find_hotspots", { max_tokens: 100, ...(cursor !== undefined ? { cursor } : {}) });
      expect(page.page.totalCount).toBe(full.hotspots.length);
      seen.push(...page.hotspots);
      truncated = page.page.truncated;
      pages++;
      if (!truncated) break;
      expect(page.page.nextCursor).toBeGreaterThan(cursor ?? 0);
      cursor = page.page.nextCursor;
    }

    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(full.hotspots.length);
  });

  it("paginates callers of a widely called method", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ count: number; callers: unknown[]; page: { truncated: boolean } }>(
      "get_callers",
      {
        symbol: "com.acme.OrderService#place",
        max_tokens: 120,
      }
    );
    expect(r.count).toBeGreaterThan(0);
    expect(r.callers.length).toBeLessThanOrEqual(r.count);
  });

  it("accepts a budget on the remaining list tools", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["trace_execution", { symbol: "com.acme.Main#main" }, "steps"],
      [
        "trace_path",
        { source: "com.acme.Main#main", target: "com.acme.OrderService#place" },
        "paths",
      ],
      ["find_aspects", {}, "aspects"],
      ["get_decorators", { symbol: "com.acme.OrderService", include_members: true }, "members"],
      ["find_external_dependencies", {}, "packages"],
    ];
    for (const [tool, args, key] of cases) {
      const r = await callTool<Record<string, unknown>>(tool, { ...args, max_tokens: 200 });
      expect(r, tool).toHaveProperty("page");
      expect(r, tool).toHaveProperty(key);
      const page = r.page as { totalCount: number; returnedCount: number };
      expect(Array.isArray(r[key]), tool).toBe(true);
      expect(page.returnedCount, tool).toBeLessThanOrEqual(page.totalCount);
    }
  });

  it("paginates implementations of an interface", async () => {
    await callTool("crawl_project", {
      path: path.join(__dirname, "fixtures", "java", "dynamic"),
    });
    const full = await callTool<{ implementations: unknown[] }>("find_implementations", {
      symbol: "com.acme.Payment",
    });
    expect(full.implementations.length).toBeGreaterThan(0);
    const budgeted = await callTool<{
      implementations: unknown[];
      page: { totalCount: number; returnedCount: number };
    }>("find_implementations", { symbol: "com.acme.Payment", max_tokens: 100 });
    expect(budgeted.page.totalCount).toBe(full.implementations.length);
    expect(budgeted.implementations.length).toBeGreaterThan(0);
  });

  it("only adds a count key to payloads that already had one", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const budgeted = await callTool<Record<string, unknown>>("find_aspects", { max_tokens: 200 });
    expect(budgeted).toHaveProperty("aspectCount");
    expect(budgeted).not.toHaveProperty("count");
    const decorators = await callTool<Record<string, unknown>>("get_decorators", {
      symbol: "com.acme.OrderService",
    });
    expect(decorators).not.toHaveProperty("count");
    expect(decorators).not.toHaveProperty("page");
  });
});

describe("MCP server resources & prompts", () => {
  it("exposes the schema and status resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "codecrawler://schema",
      "codecrawler://status",
    ]);
  });

  it("reads the schema resource", async () => {
    const res = await client.readResource({ uri: "codecrawler://schema" });
    const text = res.contents[0]?.text;
    expect(text).toContain('"CALLS"');
  });

  it("exposes the trace-call-path prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("trace-call-path");
  });
});

describe("MCP server error boundary", () => {
  it("returns a structured error instead of throwing when a handler fails", async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-srv-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-srv-b-"));
    try {
      fs.writeFileSync(path.join(first, "a.py"), "def a():\n    return 1\n");
      fs.writeFileSync(path.join(second, "b.py"), "def b():\n    return 2\n");

      const ok = await callTool<{ ok: boolean }>("crawl_project", { path: first });
      expect(ok.ok).toBe(true);

      const failure = await callTool<{ ok: boolean; error: string; hint: string }>(
        "crawl_project",
        {
          path: second,
        }
      );
      expect(failure.ok).toBe(false);
      expect(failure.error).toMatch(/already contains/);
      expect(failure.hint.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("returns a structured error for an unknown symbol lookup", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ ok: boolean; error: string; hint: string }>("get_node", {
      qualified_name: "com.acme.DoesNotExist",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
    expect(r.hint.length).toBeGreaterThan(0);
  });
});
