import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pythonConfig } from "../src/parser/languages/python.js";

const FIXTURES = path.join(__dirname, "fixtures", "python", "sample");

async function parse(rel: string) {
  const file = path.join(FIXTURES, rel);
  return pythonConfig.parseFile(fs.readFileSync(file, "utf8"), file, { projectRoot: FIXTURES });
}

describe("Python parser", () => {
  it("derives dotted module ids relative to the project root", async () => {
    expect((await parse("app/__init__.py")).moduleId).toBe("app");
    expect((await parse("app/service.py")).moduleId).toBe("app.service");
  });

  it("extracts types, methods and fields", async () => {
    const pf = await parse("app/repository.py");
    expect(pf.types.map((t) => t.id)).toEqual(["module:app.repository", "app.repository.OrderRepository"]);
    expect(pf.methods.map((m) => m.id)).toEqual([
      "app.repository.OrderRepository#<init>",
      "app.repository.OrderRepository#create",
      "app.repository.OrderRepository#find",
    ]);
    expect(pf.fields.map((f) => [f.id, f.type])).toEqual([
      ["app.repository.OrderRepository$table", "str"],
      ["app.repository.OrderRepository$rows", "list[dict]"],
    ]);
  });

  it("models decorators as annotations", async () => {
    const pf = await parse("app/service.py");
    const service = pf.types.find((t) => t.id === "app.service.OrderService");
    expect(service?.annotations.map((a) => a.name)).toEqual(["injectable"]);
    const api = await parse("app/api.py");
    expect(api.methods.find((m) => m.name === "read_order")?.annotations.map((a) => a.name)).toEqual(["get"]);
  });

  it("records constructor parameter injection", async () => {
    const pf = await parse("app/service.py");
    expect(pf.injections).toEqual([
      expect.objectContaining({
        name: "repo",
        type: "OrderRepository",
        ownerId: "app.service.OrderService",
        framework: "dependency-injector",
      }),
    ]);
  });

  it("records FastAPI routes for decorated handlers", async () => {
    const pf = await parse("app/api.py");
    expect(pf.routes?.map((r) => `${r.httpMethod} ${r.path} -> ${r.handlerName}`)).toEqual([
      "GET /orders/{order_id} -> read_order",
      "POST /orders -> create_order",
    ]);
    // Depends()-supplied parameters are framework-injected, not call sites.
    expect(pf.injections?.length).toBe(2);
    expect(pf.injections?.every((i) => i.type === "OrderService" && i.framework === "fastapi")).toBe(true);
  });

  it("records dynamic imports and getattr as reflection", async () => {
    const pf = await parse("app/dynamic.py");
    expect(pf.reflectiveRefs?.map((r) => r.mechanism)).toEqual(["importlib.import_module", "getattr"]);
    expect(pf.reflectiveRefs?.[0].target).toContain("app.plugins.");
  });

  it("marks __main__ scripts as cli entry points", async () => {
    const pf = await parse("app/main.py");
    expect(pf.entryPoint).toEqual({ kind: "cli", detail: "__main__" });
  });

  it("attributes call sites to the enclosing class and method", async () => {
    const pf = await parse("app/service.py");
    const create = pf.callSites.find((c) => c.name === "create");
    expect(create).toMatchObject({
      receiver: "self.repo",
      enclosingTypeId: "app.service.OrderService",
      enclosingMethodId: "app.service.OrderService#place",
    });
    expect(pf.callSites.find((c) => c.name === "audit")?.enclosingMethodId).toBe("app.service.OrderService#place");
  });

  it("annotates call sites with their enclosing control flow", async () => {
    const pf = await parse("app/repository.py");
    const guarded = pf.callSites.find((c) => c.name === "get");
    expect(guarded?.controlFlow?.kinds).toContain("loop");
    expect(guarded?.controlFlow?.kinds).toContain("branch");
    expect(guarded?.controlFlow?.guards.length).toBeGreaterThan(0);
    // The raise sits behind the guard, so its call site carries it too.
    expect(pf.callSites.find((c) => c.name === "ValueError")?.controlFlow?.guards).toEqual(["not order_id"]);
  });

  it("infers element types for container iteration", async () => {
    const pf = await parse("app/repository.py");
    expect(pf.localsByMethod.get("app.repository.OrderRepository#create")?.get("row")).toBe("dict");
  });

  it("records imported modules for resolution", async () => {
    const pf = await parse("app/service.py");
    expect(pf.imports).toContainEqual(
      expect.objectContaining({ module: "app.repository", importedName: "OrderRepository", simpleName: "OrderRepository" }),
    );
    const api = await parse("app/api.py");
    // One import per statement, no duplicates from the module name.
    expect(api.imports.map((i) => i.fqn)).toEqual(["fastapi.APIRouter", "fastapi.Depends", "app.service.OrderService"]);
  });
});
