import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import {
  externalDependencies,
  findEntryPoints,
  findInjections,
  findReflections,
  findRoutes,
} from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

/**
 * Language conformance contract.
 *
 * Every supported language is held to the same set of graph invariants, so a
 * parser or resolver change that silently stops emitting calls, containers or
 * imports for one language fails here rather than only in review. The per-row
 * facts below are the language-specific specifics layered on top.
 */
interface LanguageContract {
  name: string;
  /** Fixture directory, relative to `tests/fixtures`. */
  dir: string[];
  language: string;
  /** Type the parser must model as a declaration node. */
  type: string;
  /** Method node belonging to `type`. */
  method: string;
  /** Call edge, written `source -> target`, between two project symbols. */
  call: string;
  /** External packages reachable from the fixture. */
  packages: string[];
  /** `tests/fixtures/java/sample` is single-package, so it has no imports. */
  imports: boolean;
  /**
   * Framework facts. `tests/fixtures/java/sample` declares no framework
   * annotations, so its row records the current Java baseline as empty.
   */
  route?: string;
  injection?: string;
  reflection?: string;
}

const CONTRACTS: LanguageContract[] = [
  {
    name: "java",
    dir: ["java", "sample"],
    language: "java",
    type: "com.acme.OrderService",
    method: "com.acme.OrderService#place",
    call: "com.acme.OrderService#place -> com.acme.OrderRepository#create",
    packages: [],
    imports: false,
  },
  {
    name: "python",
    dir: ["python", "sample"],
    language: "python",
    type: "app.service.OrderService",
    method: "app.service.OrderService#place",
    call: "app.service.OrderService#place -> app.repository.OrderRepository#create",
    packages: ["builtins", "fastapi", "importlib", "injection"],
    imports: true,
    route: "POST /orders -> module:app.api#create_order",
    injection: "app.service.OrderService:repo -> app.repository.OrderRepository",
    reflection:
      "importlib.import_module module:app.dynamic#load_plugin -> __reflect__:app.plugins.",
  },
  {
    name: "typescript",
    dir: ["typescript", "sample"],
    language: "typescript",
    type: "src.service.OrderService",
    method: "src.service.OrderService#place",
    call: "src.service.OrderService#place -> src.repository.OrderRepository#create",
    packages: ["@nestjs/common", "console", "express"],
    imports: true,
    route: "GET /orders/:id -> src.controller.OrderController#read",
    injection: "src.service.OrderService:repo -> src.repository.OrderRepository",
    reflection: `import() module:src.dynamic#loadPlugin -> __reflect__:./plugins/\${name}`,
  },
];

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

function fixtureDir(contract: LanguageContract): string {
  return path.join(__dirname, "fixtures", ...contract.dir);
}

function crawlFixture(contract: LanguageContract) {
  return crawlProject(store, fixtureDir(contract), loadConfig().excludeDirs, {});
}

function nodeIds(...kinds: string[]): string[] {
  const placeholders = kinds.map(() => "?").join(", ");
  return store
    .raw<{ id: string }>(
      `SELECT id FROM nodes WHERE kind IN (${placeholders}) ORDER BY id`,
      ...kinds
    )
    .map((row) => row.id);
}

function edgePairs(kind: string): string[] {
  return store
    .raw<{ source: string; target: string }>(
      "SELECT source, target FROM edges WHERE kind = ? ORDER BY source, target",
      kind
    )
    .map((row) => `${row.source} -> ${row.target}`);
}

function count(sql: string, ...params: unknown[]): number {
  return store.raw<{ n: number }>(sql, ...params)[0]?.n ?? 0;
}

describe.each(CONTRACTS)("$name conformance", (contract) => {
  it("parses the fixture as exactly one language", async () => {
    const result = await crawlFixture(contract);
    expect(result.languages).toEqual([contract.language]);
    expect(result.filesParsed).toBeGreaterThan(0);
  });

  it("models the fixture's declarations", async () => {
    await crawlFixture(contract);
    expect(nodeIds("class", "interface")).toContain(contract.type);
    expect(nodeIds("method")).toContain(contract.method);
  });

  it("resolves calls between project symbols", async () => {
    await crawlFixture(contract);
    expect(edgePairs("CALLS")).toContain(contract.call);
  });

  it("keeps every edge endpoint present in the graph", async () => {
    // Referential integrity is the invariant the property graph relies on:
    // a dangling endpoint makes traversal silently drop a hop.
    await crawlFixture(contract);
    expect(
      count(
        `SELECT COUNT(*) n FROM edges e
          WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = e.source)
             OR NOT EXISTS (SELECT 1 FROM nodes WHERE id = e.target)`
      )
    ).toBe(0);
  });

  it("places every method inside a declaring symbol", async () => {
    await crawlFixture(contract);
    expect(
      count(
        `SELECT COUNT(*) n FROM nodes n WHERE n.kind IN ('method', 'constructor')
           AND NOT EXISTS (
             SELECT 1 FROM edges e
              WHERE e.target = n.id AND e.kind IN ('CONTAINS', 'DECLARED_IN')
           )`
      )
    ).toBe(0);
  });

  it("gives every node of a non-phantom kind a file or declaring owner", async () => {
    await crawlFixture(contract);
    expect(
      count(
        `SELECT COUNT(*) n FROM nodes n
          WHERE n.kind IN ('class', 'interface', 'method', 'constructor', 'field')
            AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id)`
      )
    ).toBe(0);
  });

  it("records imports as edges to import nodes", async () => {
    await crawlFixture(contract);
    const imports = edgePairs("IMPORTS");
    if (contract.imports) expect(imports.length).toBeGreaterThan(0);
    expect(
      count(
        `SELECT COUNT(*) n FROM edges e WHERE e.kind = 'IMPORTS'
           AND NOT EXISTS (SELECT 1 FROM nodes WHERE id = e.target)`
      )
    ).toBe(0);
  });

  it("reports the fixture's external packages", async () => {
    await crawlFixture(contract);
    const packages = externalDependencies(store)
      .map((dependency) => dependency.package)
      .sort();
    expect(packages).toEqual(contract.packages);
  });

  it("recovers the framework facts the fixture declares", async () => {
    await crawlFixture(contract);
    const routes = findRoutes(store).map((r) => `${r.httpMethod} ${r.path} -> ${r.target.id}`);
    const injections = findInjections(store).map(
      (i) => `${i.source.id}:${i.injectedName} -> ${i.target.id}`
    );
    const reflections = findReflections(store).map(
      (r) => `${r.mechanism} ${r.source.id} -> ${r.target.id}`
    );

    if (contract.route) expect(routes).toContain(contract.route);
    else expect(routes).toEqual([]);
    if (contract.injection) expect(injections).toContain(contract.injection);
    else expect(injections).toEqual([]);
    if (contract.reflection) expect(reflections).toContain(contract.reflection);
    else expect(reflections).toEqual([]);
  });

  it("identifies entry points without losing framework-invoked handlers", async () => {
    await crawlFixture(contract);
    const entryPoints = findEntryPoints(store).map((entry) => entry.symbol.id);
    expect(entryPoints.length).toBeGreaterThan(0);
    for (const route of findRoutes(store)) {
      expect(entryPoints).toContain(route.target.id);
    }
  });
});

describe("java language features", () => {
  it("links interface implementations and aspect advice", async () => {
    store.clearAll();
    await crawlProject(
      store,
      path.join(__dirname, "fixtures", "java", "dynamic"),
      loadConfig().excludeDirs,
      {}
    );

    expect(edgePairs("IMPLEMENTS").sort()).toEqual([
      "com.acme.CardPayment -> com.acme.Payment",
      "com.acme.UpiPayment -> com.acme.Payment",
    ]);
    expect(edgePairs("DYNAMIC_DISPATCH").sort()).toEqual([
      "com.acme.Payment#pay -> com.acme.CardPayment#pay",
      "com.acme.Payment#pay -> com.acme.UpiPayment#pay",
    ]);
    expect(edgePairs("ADVISES")).toContain(
      "com.acme.AuditAspect#auditPayment -> com.acme.Payment#pay"
    );
  });

  it("keeps declared annotations queryable across languages", async () => {
    store.clearAll();
    await crawlProject(
      store,
      path.join(__dirname, "fixtures", "java", "dynamic"),
      loadConfig().excludeDirs,
      {}
    );
    const javaAnnotations = edgePairs("ANNOTATED_WITH");
    expect(javaAnnotations).toContain("com.acme.CardPayment#pay -> @Override");

    store.clearAll();
    await crawlProject(
      store,
      path.join(__dirname, "fixtures", "typescript", "sample"),
      loadConfig().excludeDirs,
      {}
    );
    expect(edgePairs("ANNOTATED_WITH")).toContain("src.controller.OrderController#read -> @Get");
  });
});
