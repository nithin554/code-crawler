import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pythonConfig } from "../src/parser/languages/python.js";

const FIXTURES = path.join(__dirname, "fixtures", "python", "fastapi", "app", "routes");

async function parse(name: string) {
  const file = path.join(FIXTURES, name);
  return pythonConfig.parseFile(fs.readFileSync(file, "utf8"), file);
}

/** Routes rendered as `VERB path -> handler`, sorted for order-independent comparison. */
async function routesOf(name: string): Promise<string[]> {
  const pf = await parse(name);
  return (pf.routes ?? []).map((r) => `${r.httpMethod} ${r.path} -> ${r.handlerName}`).sort();
}

describe("FastAPI route groups", () => {
  it("prefixes every route declared on the group", async () => {
    expect(await routesOf("items.py")).toEqual([
      "DELETE /items/{item_id} -> delete_item",
      "GET /items/ -> read_items",
      "GET /items/{item_id} -> read_item",
      "POST /items/ -> create_item",
    ]);
  });

  it("keeps the trailing slash FastAPI actually serves", async () => {
    const pf = await parse("items.py");
    const root = (pf.routes ?? []).find((r) => r.handlerName === "read_items");
    expect(root?.path).toBe("/items/");
  });

  it("reads the prefix regardless of keyword argument order", async () => {
    expect(await routesOf("private.py")).toEqual(["POST /private/users/ -> create_private_user"]);
  });

  it("leaves decorator paths untouched when the group has no prefix", async () => {
    expect(await routesOf("health.py")).toEqual(["GET /health-check/ -> health_check"]);
  });

  it("applies only the prefix of the group the handler hangs off", async () => {
    expect(await routesOf("grouped.py")).toEqual(["GET /ping -> ping", "GET /users/me -> read_me"]);
  });

  it("ignores a prefix keyword on something that is not a route group", async () => {
    const pf = await parse("grouped.py");
    expect((pf.routes ?? []).some((r) => r.path.startsWith("/config"))).toBe(false);
  });

  it("records the served path as the entry point detail", async () => {
    const pf = await parse("items.py");
    const readItem = pf.methods.find((m) => m.name === "read_item");
    expect(readItem?.entryPoint).toEqual({ kind: "http", detail: "GET /items/{item_id}" });
  });

  it("attributes group routes to fastapi, not to the receiver variable", async () => {
    const pf = await parse("items.py");
    expect(new Set((pf.routes ?? []).map((r) => r.framework))).toEqual(new Set(["fastapi"]));
  });
});
