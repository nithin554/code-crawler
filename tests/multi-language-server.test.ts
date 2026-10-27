import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import path from "node:path";

const PYTHON = path.join(__dirname, "fixtures", "python", "sample");
const TYPESCRIPT = path.join(__dirname, "fixtures", "typescript", "sample");

interface Ref {
  id: string;
  qualifiedName: string;
  name: string;
  kind: string;
}

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

async function crawl(dir: string) {
  store.clearAll();
  return callTool<{ ok: boolean; filesParsed: number; languages: string[]; routes: number; injections: number }>(
    "crawl_project",
    { path: dir },
  );
}

describe("Python project via MCP", () => {
  it("crawl_project reports the detected language", async () => {
    const r = await crawl(PYTHON);
    expect(r.ok).toBe(true);
    expect(r.filesParsed).toBe(6);
    expect(r.languages).toEqual(["python"]);
    expect(r.routes).toBe(2);
  });

  it("find_entry_points lists framework roots", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; entryPoints: { symbol: Ref; entryPointKind: string; detail?: string }[] }>(
      "find_entry_points",
    );
    expect(r.count).toBe(4);
    const byId = new Map(r.entryPoints.map((e) => [e.symbol.id, e]));
    expect(byId.get("module:app.api#read_order")).toMatchObject({ entryPointKind: "http", detail: "GET /orders/{order_id}" });
    expect(byId.get("module:app.main#main")?.entryPointKind).toBe("cli");
  });

  it("find_entry_points filters by kind", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; entryPoints: { entryPointKind: string }[] }>("find_entry_points", { kind: "http" });
    expect(r.count).toBe(2);
    expect(r.entryPoints.every((e) => e.entryPointKind === "http")).toBe(true);
  });

  it("find_routes maps HTTP routes to Python handlers", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; routes: { handler: Ref; httpMethod: string; path: string }[] }>("find_routes");
    expect(r.count).toBe(2);
    expect(r.routes.map((x) => `${x.httpMethod} ${x.path} -> ${x.handler.id}`).sort()).toEqual([
      "GET /orders/{order_id} -> module:app.api#read_order",
      "POST /orders -> module:app.api#create_order",
    ]);
  });

  it("find_injections shows framework wiring", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; injections: { source: Ref; target: Ref; injectedName?: string; framework?: string }[] }>(
      "find_injections",
    );
    expect(r.count).toBe(2);
    expect(r.injections.map((i) => `${i.source.id}:${i.injectedName} -> ${i.target.id}`).sort()).toEqual([
      "app.service.OrderService:repo -> app.repository.OrderRepository",
      "module:app.api:service -> app.service.OrderService",
    ]);
  });

  it("find_reflections shows dynamic imports", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; reflections: { source: Ref; mechanism?: string }[] }>("find_reflections");
    expect(r.count).toBe(1);
    expect(r.reflections[0].source.id).toBe("module:app.dynamic#load_plugin");
    expect(r.reflections[0].mechanism).toBe("importlib.import_module");
  });

  it("find_external_dependencies separates libraries from project code", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ count: number; packages: { package: string; references: number }[] }>(
      "find_external_dependencies",
    );
    const names = r.packages.map((p) => p.package);
    expect(names).toEqual(expect.arrayContaining(["fastapi", "builtins", "injection", "importlib"]));
    expect(names.some((n) => n.startsWith("app."))).toBe(false);
  });

  it("trace_execution starts from a framework root", async () => {
    await crawl(PYTHON);
    const r = await callTool<{ root: Ref; steps: { symbol: Ref; via?: string }[] }>("trace_execution", {
      symbol: "module:app.api#read_order",
    });
    expect(r.root.id).toBe("module:app.api#read_order");
    expect(r.steps.map((s) => s.symbol.id)).toContain("app.repository.OrderRepository#find");
  });
});

describe("TypeScript project via MCP", () => {
  it("crawl_project reports the detected language", async () => {
    const r = await crawl(TYPESCRIPT);
    expect(r.filesParsed).toBe(6);
    expect(r.languages).toEqual(["typescript"]);
    expect(r.routes).toBe(4);
  });

  it("find_routes includes NestJS and inline express handlers", async () => {
    await crawl(TYPESCRIPT);
    const r = await callTool<{ count: number; routes: { handler: Ref; httpMethod: string; path: string }[] }>("find_routes");
    expect(r.count).toBe(4);
    const routes = r.routes.map((x) => `${x.httpMethod} ${x.path} -> ${x.handler.id}`);
    expect(routes).toContain("GET /orders/:id -> src.controller.OrderController#read");
    expect(routes).toContain("POST /orders -> module:src.routes#<anonymous@11>");
  });

  it("find_injections ignores primitive parameters", async () => {
    await crawl(TYPESCRIPT);
    const r = await callTool<{ count: number; injections: { source: Ref; target: Ref }[] }>("find_injections");
    expect(r.count).toBe(2);
    expect(r.injections.map((i) => `${i.source.id} -> ${i.target.id}`).sort()).toEqual([
      "src.controller.OrderController -> src.service.OrderService",
      "src.service.OrderService -> src.repository.OrderRepository",
    ]);
  });

  it("find_reflections surfaces dynamic import()", async () => {
    await crawl(TYPESCRIPT);
    const r = await callTool<{ count: number; reflections: { mechanism?: string; target: Ref }[] }>("find_reflections");
    expect(r.count).toBe(1);
    expect(r.reflections[0].mechanism).toBe("import()");
    expect(r.reflections[0].target.id).toContain("__reflect__:");
  });

  it("find_external_dependencies lists npm and runtime globals", async () => {
    await crawl(TYPESCRIPT);
    const r = await callTool<{ packages: { package: string; kinds: string[] }[] }>("find_external_dependencies");
    expect(r.packages.map((p) => p.package).sort()).toEqual(["@nestjs/common", "console", "express"]);
    expect(r.packages.find((p) => p.package === "@nestjs/common")?.kinds).toContain("REFERENCES");
  });
});
