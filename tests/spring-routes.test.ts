import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { javaConfig } from "../src/parser/languages/java.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "spring", "com", "acme", "web");

async function parse(name: string) {
  const file = path.join(FIXTURES, name);
  return javaConfig.parseFile(fs.readFileSync(file, "utf8"), file);
}

/** Routes rendered as `VERB path -> handler`, sorted for order-independent comparison. */
async function routesOf(name: string): Promise<string[]> {
  const pf = await parse(name);
  return (pf.routes ?? []).map((r) => `${r.httpMethod} ${r.path} -> ${r.handlerName}`).sort();
}

describe("Spring route extraction", () => {
  it("joins the class prefix with every method path form", async () => {
    expect(await routesOf("OwnerController.java")).toEqual([
      "GET /owners/{ownerId}/appointments -> visits",
      "GET /owners/{ownerId}/pets -> listPets",
      "GET /owners/{ownerId}/visits -> visits",
      "POST /owners/{ownerId}/pets -> addPet",
      "PUT /owners/{ownerId}/pets/{petId} -> updatePet",
    ]);
  });

  it("attributes every route to the spring framework", async () => {
    const pf = await parse("OwnerController.java");
    expect(new Set((pf.routes ?? []).map((r) => r.framework))).toEqual(new Set(["spring"]));
  });

  it("emits one route per path in the array form", async () => {
    const pf = await parse("OwnerController.java");
    const visits = (pf.routes ?? []).filter((r) => r.handlerName === "visits");
    expect(visits.map((r) => r.path).sort()).toEqual([
      "/owners/{ownerId}/appointments",
      "/owners/{ownerId}/visits",
    ]);
    expect(visits.every((r) => r.httpMethod === "GET")).toBe(true);
  });

  it("takes the verb from RequestMapping's method attribute instead of defaulting", async () => {
    const pf = await parse("OwnerController.java");
    const update = (pf.routes ?? []).find((r) => r.handlerName === "updatePet");
    expect(update?.httpMethod).toBe("PUT");
  });

  it("inherits the class prefix for a bare verb annotation and keeps non-identifier paths", async () => {
    expect(await routesOf("VetController.java")).toEqual([
      "GET /vets -> list",
      "GET /vets/vets.html -> html",
    ]);
  });

  it("roots a route from a class with no prefix", async () => {
    expect(await routesOf("RootController.java")).toEqual(["GET / -> index"]);
  });

  it("emits nothing for a class with no registered mapping annotation", async () => {
    const pf = await parse("JaxRsResource.java");
    expect(pf.routes ?? []).toEqual([]);
    expect(pf.types.map((t) => t.id)).toEqual(["com.acme.web.JaxRsResource"]);
  });

  it("does not emit a route for a method with no mapping annotation", async () => {
    const pf = await parse("OwnerController.java");
    expect((pf.routes ?? []).some((r) => r.handlerName === "helper")).toBe(false);
  });

  it("records the served path as the entry point detail", async () => {
    const pf = await parse("OwnerController.java");
    const listPets = pf.methods.find((m) => m.name === "listPets");
    expect(listPets?.entryPoint).toEqual({ kind: "http", detail: "GET /owners/{ownerId}/pets" });
  });

  it("describes an array-form mapping by its first path", async () => {
    const pf = await parse("OwnerController.java");
    const visits = pf.methods.find((m) => m.name === "visits");
    expect(visits?.entryPoint).toEqual({
      kind: "http",
      detail: "GET /owners/{ownerId}/visits",
    });
  });
});
