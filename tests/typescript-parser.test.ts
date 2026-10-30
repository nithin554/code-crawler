import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { typescriptConfig } from "../src/parser/languages/typescript.js";

const FIXTURES = path.join(__dirname, "fixtures", "typescript", "sample");

async function parse(rel: string) {
  const file = path.join(FIXTURES, rel);
  return typescriptConfig.parseFile(fs.readFileSync(file, "utf8"), file, { projectRoot: FIXTURES });
}

describe("TypeScript parser", () => {
  it("derives dotted module ids, collapsing index files", async () => {
    expect((await parse("src/index.ts")).moduleId).toBe("src");
    expect((await parse("src/service.ts")).moduleId).toBe("src.service");
  });

  it("extracts interfaces, classes, methods and fields", async () => {
    const pf = await parse("src/repository.ts");
    expect(pf.types.map((t) => [t.id, t.kind])).toEqual([
      ["module:src.repository", "module"],
      ["src.repository.Repository", "interface"],
      ["src.repository.OrderRepository", "class"],
      ["src.repository.Order", "interface"],
    ]);
    expect(pf.methods.map((m) => m.id)).toEqual([
      "src.repository.Repository#create",
      "src.repository.Repository#find",
      "src.repository.OrderRepository#create",
      "src.repository.OrderRepository#find",
    ]);
    expect(pf.fields.map((f) => [f.id, f.type])).toEqual([
      ["src.repository.OrderRepository$rows", "Order[]"],
    ]);
  });

  it("models decorators as annotations", async () => {
    const pf = await parse("src/controller.ts");
    const controller = pf.types.find((t) => t.id === "src.controller.OrderController");
    expect(controller?.annotations.map((a) => a.name)).toEqual(["Controller"]);
    expect(pf.methods.find((m) => m.name === "read")?.annotations.map((a) => a.name)).toEqual([
      "Get",
    ]);
  });

  it("derives NestJS routes from controller and method decorators", async () => {
    const pf = await parse("src/controller.ts");
    expect(pf.routes?.map((r) => `${r.httpMethod} ${r.path} -> ${r.handlerName}`)).toEqual([
      "GET /orders/:id -> read",
      "POST /orders -> create",
    ]);
    expect(pf.methods.find((m) => m.name === "read")?.entryPoint).toEqual({
      kind: "http",
      detail: "GET /orders/:id",
    });
  });

  it("records constructor parameter injection", async () => {
    const pf = await parse("src/service.ts");
    expect(pf.injections).toEqual([
      expect.objectContaining({
        name: "repo",
        type: "OrderRepository",
        ownerId: "src.service.OrderService",
        framework: "ts-di",
      }),
    ]);
  });

  it("synthesises handlers for inline express routes", async () => {
    const pf = await parse("src/routes.ts");
    expect(pf.routes?.map((r) => `${r.httpMethod} ${r.path} -> ${r.handlerName}`)).toEqual([
      "GET /orders/:id -> <anonymous@7>",
      "POST /orders -> <anonymous@11>",
    ]);
    const handlers = pf.methods.filter((m) => m.id.includes("<anonymous@"));
    expect(handlers.map((m) => m.entryPoint?.kind)).toEqual(["http", "http"]);
    // Calls inside the inline arrow keep the synthetic handler as their enclosure.
    expect(pf.callSites.find((c) => c.name === "place")?.enclosingMethodId).toBe(
      "module:src.routes#<anonymous@7>"
    );
  });

  it("records dynamic import() as reflection", async () => {
    const pf = await parse("src/dynamic.ts");
    expect(pf.reflectiveRefs?.map((r) => r.mechanism)).toEqual(["import()"]);
    expect(pf.reflectiveRefs?.[0].target).toContain("./plugins/");
  });

  it("distinguishes internal from external imports", async () => {
    const pf = await parse("src/controller.ts");
    expect(pf.imports.find((i) => i.simpleName === "Controller")?.external).toBe(true);
    expect(pf.imports.find((i) => i.simpleName === "OrderService")?.external).toBe(false);
  });

  it("attributes member calls to the enclosing class and method", async () => {
    const pf = await parse("src/service.ts");
    expect(pf.callSites.find((c) => c.name === "create")).toMatchObject({
      receiver: "this.repo",
      enclosingTypeId: "src.service.OrderService",
      enclosingMethodId: "src.service.OrderService#place",
    });
  });

  it("keeps primitive parameter types out of receiver inference", async () => {
    const pf = await parse("src/controller.ts");
    expect(pf.localsByMethod.get("src.controller.OrderController#read")?.get("id")).toBe("string");
  });
});
