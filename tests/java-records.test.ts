import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { getCallees } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";
import { javaConfig } from "../src/parser/languages/java.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "records");

const RECORD_SOURCE = `package com.acme;

public record Range(int low, int high, String... tags) implements Comparable<Range> {
  public Range {
    if (low > high) throw new IllegalArgumentException("low");
  }

  public int width() {
    return high - low;
  }
}
`;

const NESTED_RECORD_SOURCE = `package com.acme;

public class Outer {
  record Inner(int value) {}
}
`;

describe("Java record parsing", () => {
  it("treats a record as a type with component fields", async () => {
    const pf = await javaConfig.parseFile(RECORD_SOURCE, "/tmp/Range.java");
    const type = pf.types.find((t) => t.id === "com.acme.Range");
    expect(type?.kind).toBe("class");
    expect(type?.isRecord).toBe(true);
    expect(type?.implementsTypes).toHaveLength(1);

    const components = pf.fields.map((f) => [f.name, f.type]);
    expect(components).toEqual([
      ["low", "int"],
      ["high", "int"],
      ["tags", "String"],
    ]);
    expect(pf.fields.find((f) => f.name === "low")?.modifiers).toEqual(["private", "final"]);
  });

  it("synthesizes an accessor per component alongside declared methods", async () => {
    const pf = await javaConfig.parseFile(RECORD_SOURCE, "/tmp/Range.java");
    const accessors = pf.methods
      .filter((m) => !m.isConstructor)
      .map((m) => `${m.name}:${m.returnType}`)
      .sort();
    expect(accessors).toEqual(["high:int", "low:int", "tags:String", "width:int"]);
  });

  it("gives the compact constructor the component parameters", async () => {
    const pf = await javaConfig.parseFile(RECORD_SOURCE, "/tmp/Range.java");
    const ctor = pf.methods.find((m) => m.isConstructor);
    expect(ctor?.id).toBe("com.acme.Range#<init>");
    expect(ctor?.params).toEqual([
      { name: "low", type: "int" },
      { name: "high", type: "int" },
      { name: "tags", type: "String" },
    ]);
  });

  it("indexes a record nested in a class", async () => {
    const pf = await javaConfig.parseFile(NESTED_RECORD_SOURCE, "/tmp/Outer.java");
    const inner = pf.types.find((t) => t.id === "com.acme.Outer.Inner");
    expect(inner?.isRecord).toBe(true);
    expect(inner?.kind).toBe("class");
    // No canonical constructor in source: only the implicit accessor is parsed.
    expect(pf.methods.map((m) => m.id)).toEqual(["com.acme.Outer.Inner#value"]);
  });
});

describe("Java records in the graph", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(":memory:", { maxDepth: 10 });
    store.clearAll();
  });

  afterEach(() => {
    store.close();
  });

  it("stores the record flag, component fields and accessors", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});

    const point = store.getNode("com.acme.Point");
    expect(point?.kind).toBe("class");
    expect(point?.properties.record).toBe(true);

    expect(store.getNode("com.acme.Point$x")?.kind).toBe("field");
    expect(store.getNode("com.acme.Point$x")?.properties.type).toBe("int");
    expect(store.getNode("com.acme.Point#x")?.kind).toBe("method");
    expect(store.getNode("com.acme.Point#y")?.properties.returnType).toBe("int");

    const ctor = store.getNode("com.acme.Point#<init>");
    expect(ctor?.properties.signature).toBe("(int, int)");
    expect(ctor?.properties.synthetic).toBeUndefined();
  });

  it("keeps a declared accessor instead of adding a second one", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const textAccessors = store.raw("SELECT id FROM nodes WHERE id = 'com.acme.Label#text'") as {
      id: string;
    }[];
    expect(textAccessors).toHaveLength(1);
    // The declared accessor's line, not the record header's.
    expect(store.getNode("com.acme.Label#text")?.properties.startLine).toBe(4);
  });

  it("resolves calls to record accessors and the canonical constructor", async () => {
    await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
    const callees = getCallees(store, "com.acme.Main#main", {});
    const ids = callees?.callees.map((c) => c.callee.qualifiedName) ?? [];
    expect(ids).toContain("com.acme.Point#<init>");
    expect(ids).toContain("com.acme.Point#x");
    expect(ids).toContain("com.acme.Label#weight");
  });
});
