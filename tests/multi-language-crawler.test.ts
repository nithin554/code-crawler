import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { GraphStore } from "../src/graph/store.js";
import { crawlProject } from "../src/crawler.js";
import {
  findEntryPoints,
  findInjections,
  findReflections,
  findRoutes,
  externalDependencies,
  deadCode,
} from "../src/graph/queries.js";
import { loadConfig } from "../src/config.js";

const PYTHON = path.join(__dirname, "fixtures", "python", "sample");
const TYPESCRIPT = path.join(__dirname, "fixtures", "typescript", "sample");

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

function edges(kind: string): { source: string; target: string; properties: string }[] {
  return store.raw("SELECT source, target, properties FROM edges WHERE kind = ? ORDER BY source, target", kind) as any;
}

async function crawl(dir: string) {
  return crawlProject(store, dir, loadConfig().excludeDirs, {});
}

describe("multi-language crawler", () => {
  it("crawls a Python project through the generic resolver", async () => {
    const result = await crawl(PYTHON);
    expect(result.filesParsed).toBe(6);
    expect(result.languages).toEqual(["python"]);
    expect(result.resolvedCalls).toBe(19);
    expect(result.unresolvedCalls).toBe(2);
    expect(result.routes).toBe(2);
    expect(result.injections).toBe(3);
    expect(result.reflections).toBe(2);
    expect(result.entryPoints).toBe(4);
    expect(result.externalDependencies).toBe(4);
  });

  it("resolves Python member calls through class fields and self", async () => {
    await crawl(PYTHON);
    const calls = edges("CALLS").map((e) => `${e.source} -> ${e.target}`);
    expect(calls).toContain("app.service.OrderService#place -> app.repository.OrderRepository#create");
    expect(calls).toContain("app.service.OrderService#place -> app.service.OrderService#audit");
    expect(calls).toContain("module:app.api#read_order -> app.repository.OrderRepository#find");
    expect(calls).toContain("module:app.api#get_service -> app.service.OrderService#<init>");
    // `self`, builtin containers and builtin exceptions are known-external, not noise nodes.
    expect(calls).toContain("app.service.OrderService#audit -> ext:builtins");
    expect(calls).toContain("module:app.dynamic#load_plugin -> ext:importlib");
    expect(calls.some((c) => c.includes("ext:self"))).toBe(false);
  });

  it("links Python routes, injections and reflections to their targets", async () => {
    await crawl(PYTHON);
    const routes = findRoutes(store).map((r) => `${r.httpMethod} ${r.path} -> ${r.target.name}`);
    expect(routes.sort()).toEqual(["GET /orders/{order_id} -> read_order", "POST /orders -> create_order"]);

    const injections = findInjections(store);
    expect(injections.map((i) => `${i.source.id}:${i.injectedName} -> ${i.target.id}`)).toEqual([
      "app.service.OrderService:repo -> app.repository.OrderRepository",
      "module:app.api:service -> app.service.OrderService",
    ]);

    const reflections = findReflections(store);
    expect(reflections[0].mechanism).toBe("importlib.import_module");
    // The prefix belongs to this project's own namespace, so it is not external.
    expect(reflections[0].target.id).toBe("__reflect__:app.plugins.");
  });

  it("crawls a TypeScript project through the generic resolver", async () => {
    const result = await crawl(TYPESCRIPT);
    expect(result.filesParsed).toBe(6);
    expect(result.languages).toEqual(["typescript"]);
    expect(result.routes).toBe(4);
    expect(result.injections).toBe(4);
    expect(result.reflections).toBe(1);
    expect(result.entryPoints).toBe(4);
    expect(result.externalDependencies).toBe(3);
  });

  it("resolves TypeScript member calls through typed fields", async () => {
    await crawl(TYPESCRIPT);
    const calls = edges("CALLS").map((e) => `${e.source} -> ${e.target}`);
    expect(calls).toContain("src.service.OrderService#place -> src.repository.OrderRepository#create");
    expect(calls).toContain("src.controller.OrderController#read -> src.service.OrderService#place");
    expect(calls).toContain("module:src#main -> src.service.OrderService#place");
    expect(calls.some((c) => c.includes("ext:this"))).toBe(false);
  });

  it("synthesises graph nodes for inline express handlers", async () => {
    await crawl(TYPESCRIPT);
    const calls = edges("CALLS").map((e) => `${e.source} -> ${e.target}`);
    expect(calls).toContain("module:src.routes#<anonymous@7> -> src.service.OrderService#place");
    expect(calls).toContain("module:src.routes#<anonymous@11> -> src.service.OrderService#place");
    const routes = findRoutes(store).map((r) => `${r.httpMethod} ${r.path} -> ${r.target.id}`);
    expect(routes.sort()).toEqual([
      "GET /orders/:id -> module:src.routes#<anonymous@7>",
      "POST /orders -> module:src.routes#<anonymous@11>",
      "GET /orders/:id -> src.controller.OrderController#read",
      "POST /orders -> src.controller.OrderController#create",
    ].sort());
  });

  it("records NestJS routes and DI wiring", async () => {
    await crawl(TYPESCRIPT);
    const injections = findInjections(store).map((i) => `${i.source.id} -> ${i.target.id}`);
    expect(injections).toContain("src.service.OrderService -> src.repository.OrderRepository");
    expect(injections).toContain("src.controller.OrderController -> src.service.OrderService");
    // Primitive and structural parameter types stay out of the DI graph.
    expect(injections.some((i) => i.includes("string"))).toBe(false);
    const edgesKinds = edges("INJECTS").map((e) => e.target);
    expect(edgesKinds).not.toContain("ext:string");
  });

  it("traces dynamic import() to a reflection marker", async () => {
    await crawl(TYPESCRIPT);
    const reflections = findReflections(store);
    expect(reflections.map((r) => r.mechanism)).toEqual(["import()"]);
    expect(reflections[0].source.id).toBe("module:src.dynamic#loadPlugin");
    expect(reflections[0].target.id).toBe("__reflect__:./plugins/${name}");
  });

  it("reports external packages rather than project files", async () => {
    await crawl(PYTHON);
    expect(externalDependencies(store).map((d) => d.package).sort()).toEqual([
      "builtins",
      "fastapi",
      "importlib",
      "injection",
    ]);

    store.clearAll();
    await crawl(TYPESCRIPT);
    expect(externalDependencies(store).map((d) => d.package).sort()).toEqual([
      "@nestjs/common",
      "console",
      "express",
    ]);
  });

  it("treats framework-invoked handlers as live code", async () => {
    await crawl(TYPESCRIPT);
    const entryPoints = findEntryPoints(store).map((e) => e.symbol.id).sort();
    expect(entryPoints).toEqual([
      "module:src.routes#<anonymous@11>",
      "module:src.routes#<anonymous@7>",
      "src.controller.OrderController#create",
      "src.controller.OrderController#read",
    ]);
    const dead = deadCode(store).map((d: any) => d.symbol?.id ?? d.symbolId ?? d.id);
    expect(dead).not.toContain("src.controller.OrderController#read");
  });

  it("keeps both languages queryable in one graph", async () => {
    await crawl(path.join(__dirname, "fixtures"));
    const classes = store.raw("SELECT id FROM nodes WHERE kind IN ('class','interface') ORDER BY id") as { id: string }[];
    const ids = classes.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "com.acme.OrderService",
        "python.sample.app.service.OrderService",
        "python.sample.app.repository.OrderRepository",
        "typescript.sample.src.service.OrderService",
        "typescript.sample.src.repository.Repository",
      ]),
    );
  });
});
