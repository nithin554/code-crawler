import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { javaConfig } from "../src/parser/languages/java.js";
import { baseTypeName } from "../src/parser/treeSitter.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "sample");

function fixture(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), "utf8");
}

async function parse(rel: string) {
  return javaConfig.parseFile(fixture(rel), path.join(FIXTURES, rel));
}

describe("Java parser", () => {
  it("extracts package and imports", async () => {
    const pf = await parse("com/acme/OrderService.java");
    expect(pf.packageName).toBe("com.acme");
  });

  it("extracts types, methods and fields", async () => {
    const pf = await parse("com/acme/OrderService.java");
    expect(pf.types.map((t) => t.id)).toEqual(["com.acme.OrderService"]);
    const methodIds = pf.methods.map((m) => m.id).sort();
    expect(methodIds).toEqual([
      "com.acme.OrderService#<init>",
      "com.acme.OrderService#notify",
      "com.acme.OrderService#place",
    ]);
    const field = pf.fields.find((f) => f.name === "repo");
    expect(field?.type).toBe("OrderRepository");
  });

  it("extracts method parameters with types", async () => {
    const pf = await parse("com/acme/OrderService.java");
    const place = pf.methods.find((m) => m.name === "place");
    expect(place?.params).toEqual([
      { name: "customer", type: "Customer" },
      { name: "item", type: "String" },
    ]);
  });

  it("extracts call sites with receivers and enclosing methods", async () => {
    const pf = await parse("com/acme/OrderService.java");
    const calls = pf.callSites;
    expect(calls).toContainEqual(
      expect.objectContaining({ name: "create", receiver: "repo", enclosingMethodId: "com.acme.OrderService#place" })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ name: "notify", receiver: null, enclosingMethodId: "com.acme.OrderService#place" })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({ name: "OrderRepository", isConstructorCall: true })
    );
  });

  it("extracts local variable types", async () => {
    const pf = await parse("com/acme/Main.java");
    const locals = pf.localsByMethod.get("com.acme.Main#main");
    expect(locals?.get("orders")).toBe("OrderService");
    expect(locals?.get("customers")).toBe("CustomerService");
  });

  it("assigns nested types dotted FQNs without double-prefixing", async () => {
    const pf = await javaConfig.parseFile(
      "package com.acme; public class Outer { public class Inner { public void go() {} } }",
      "/tmp/Outer.java"
    );
    expect(pf.types.map((t) => t.id)).toEqual(["com.acme.Outer", "com.acme.Outer.Inner"]);
  });

  it("does not crash on parse errors", async () => {
    const pf = await javaConfig.parseFile("public class Broken { void x( { }", "/tmp/Broken.java");
    expect(pf.types.length).toBeGreaterThanOrEqual(1);
  });
});

describe("baseTypeName", () => {
  it("strips generics, arrays and varargs", () => {
    expect(baseTypeName("List<String>")).toBe("List");
    expect(baseTypeName("java.util.Map<K, V>")).toBe("java.util.Map");
    expect(baseTypeName("int[]")).toBe("int");
    expect(baseTypeName("String...")).toBe("String");
  });
});
