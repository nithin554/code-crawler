import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import path from "node:path";

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

async function callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`tool ${name} returned no text`);
  return JSON.parse(text) as T;
}

describe("MCP server tools", () => {
  it("exposes all 10 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "clear_index",
        "crawl_project",
        "get_callers",
        "get_callees",
        "get_node",
        "get_schema",
        "get_subgraph",
        "index_status",
        "search_symbols",
        "trace_path",
      ].sort()
    );
  });

  it("crawl_project -> index_status round trip", async () => {
    const crawl = await callTool<{ ok: boolean; filesParsed: number; resolvedCalls: number; unresolvedCalls: number }>(
      "crawl_project",
      { path: FIXTURES }
    );
    expect(crawl.ok).toBe(true);
    expect(crawl.filesParsed).toBe(8);
    expect(crawl.resolvedCalls).toBe(15);
    expect(crawl.unresolvedCalls).toBe(1);

    const status = await callTool<{ nodes: number; edges: number }>("index_status");
    expect(status.nodes).toBe(39);
    expect(status.edges).toBe(58);
  });

  it("search_symbols finds methods", async () => {
    await callTool("crawl_project", { path: FIXTURES });
    const r = await callTool<{ results: { qualifiedName: string }[] }>("search_symbols", { query: "place" });
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
    const r = await callTool<{ callees: { callee: { qualifiedName: string } }[] }>(
      "get_callees",
      { symbol: "com.acme.Main#main" }
    );
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
    const r = await callTool<{ center: { qualifiedName: string }; nodeCount: number }>("get_subgraph", {
      symbol: "com.acme.OrderService#place",
      radius: 1,
    });
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

describe("MCP server resources & prompts", () => {
  it("exposes the schema and status resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["codecrawler://schema", "codecrawler://status"]);
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
