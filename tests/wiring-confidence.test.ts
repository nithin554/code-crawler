import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { findInjections, findRoutes } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";
import {
  INJECT_CONFIDENCE_UNIQUE_TYPE,
  INJECT_CONFIDENCE_UNRESOLVED,
  ROUTE_CONFIDENCE_DIRECT,
} from "../src/resolver/genericResolver.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "spring");

interface EdgeRow {
  source: string;
  target: string;
  properties: string;
}

interface PropRow {
  confidence?: number;
  framework?: string;
}

let store: GraphStore;

function edgesOf(kind: string): EdgeRow[] {
  return store.raw<EdgeRow>(
    "SELECT source, target, properties FROM edges WHERE kind = ? ORDER BY source, target",
    kind
  );
}

function propsOf(kind: string, source: string, target: string): PropRow {
  const edge = edgesOf(kind).find((e) => e.source === source && e.target === target);
  return edge ? (JSON.parse(edge.properties) as PropRow) : {};
}

function nodeExists(id: string): boolean {
  return store.raw<{ id: string }>("SELECT id FROM nodes WHERE id = ?", id).length === 1;
}

async function crawl(root: string): Promise<void> {
  await crawlProject(store, root, loadConfig().excludeDirs, {});
}

/** A copy of the Spring fixture so a test can add and remove files. */
function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-wiring-"));
  fs.cpSync(FIXTURES, root, { recursive: true });
  return root;
}

beforeAll(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  await crawl(FIXTURES);
});

afterAll(() => {
  store.close();
});

describe("INJECTS confidence", () => {
  it("gives a uniquely matched project type the inference band", () => {
    expect(
      propsOf("INJECTS", "com.acme.wiring.FieldInjectedService", "com.acme.wiring.GreetingService")
    ).toMatchObject({ confidence: INJECT_CONFIDENCE_UNIQUE_TYPE });
  });

  it("marks constructor parameters and field injection the same way", () => {
    for (const target of ["GreetingService", "AuditService"]) {
      const props = propsOf(
        "INJECTS",
        "com.acme.wiring.ConstructorInjectedController",
        `com.acme.wiring.${target}`
      );
      expect(props.confidence).toBe(INJECT_CONFIDENCE_UNIQUE_TYPE);
      expect(props.framework).toBe("spring");
    }
  });

  it("puts every injection on the shared band scale", () => {
    const edges = edgesOf("INJECTS");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const { confidence } = JSON.parse(edge.properties) as PropRow;
      expect(typeof confidence).toBe("number");
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("never invents a target node id", () => {
    for (const edge of edgesOf("INJECTS")) {
      expect(nodeExists(edge.target)).toBe(true);
    }
  });
});

describe("ROUTES confidence", () => {
  it("is certain when the handler is declared in the registering type", () => {
    expect(
      propsOf("ROUTES", "com.acme.web.OwnerController", "com.acme.web.OwnerController#listPets")
    ).toMatchObject({ confidence: ROUTE_CONFIDENCE_DIRECT });
  });

  it("puts every route on the shared band scale", () => {
    const edges = edgesOf("ROUTES");
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const { confidence } = JSON.parse(edge.properties) as PropRow;
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("never invents a handler node id", () => {
    for (const edge of edgesOf("ROUTES")) {
      expect(nodeExists(edge.target)).toBe(true);
    }
  });
});

describe("unresolved dependencies stay visible", () => {
  let unresolvedRoot: string;

  beforeAll(() => {
    unresolvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-wiring-unresolved-"));
    fs.mkdirSync(path.join(unresolvedRoot, "com", "acme"), { recursive: true });
    fs.writeFileSync(
      path.join(unresolvedRoot, "com", "acme", "UsesMissing.java"),
      `package com.acme;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
@Component
public class UsesMissing {
  @Autowired private MissingDependency missing;
}
`
    );
  });

  it("reports confidence zero and a named placeholder instead of dropping the edge", async () => {
    const scoped = new GraphStore(":memory:", { maxDepth: 10 });
    scoped.clearAll();
    await crawlProject(scoped, unresolvedRoot, loadConfig().excludeDirs, {});
    const edges = scoped.raw<EdgeRow>(
      "SELECT source, target, properties FROM edges WHERE kind = 'INJECTS'"
    );
    expect(edges).toHaveLength(1);
    const [edge] = edges;
    expect(edge?.target).toBe("__inject__:MissingDependency");
    expect((JSON.parse(edge?.properties ?? "{}") as PropRow).confidence).toBe(
      INJECT_CONFIDENCE_UNRESOLVED
    );
    const nodes = scoped.raw<{ kind: string; properties: string }>(
      "SELECT kind, properties FROM nodes WHERE id = ?",
      "__inject__:MissingDependency"
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("unknown_symbol");
    expect(JSON.parse(nodes[0]?.properties ?? "{}")).toMatchObject({
      reason: "unresolved injected type",
    });
    scoped.close();
  });
});

describe("incremental crawls keep the edges honest", () => {
  let root: string;

  beforeAll(() => {
    root = copyFixture();
  });

  it("adds a confident edge for a new file and rebuilds the existing ones", async () => {
    const scoped = new GraphStore(":memory:", { maxDepth: 10 });
    scoped.clearAll();
    await crawlProject(scoped, root, loadConfig().excludeDirs, {});
    const before = scoped.raw<EdgeRow>(
      "SELECT source, target, properties FROM edges WHERE kind='INJECTS'"
    );
    expect(before.length).toBeGreaterThan(0);

    const added = path.join(root, "com", "acme", "wiring", "LateArrival.java");
    fs.writeFileSync(
      added,
      `package com.acme.wiring;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
@Component
public class LateArrival {
  @Autowired private GreetingService greeting;
}
`
    );
    await crawlProject(scoped, root, loadConfig().excludeDirs, {});

    const edges = scoped.raw<EdgeRow>(
      "SELECT source, target, properties FROM edges WHERE kind = 'INJECTS'"
    );
    const late = edges.find((e) => e.source === "com.acme.wiring.LateArrival");
    expect(late?.target).toBe("com.acme.wiring.GreetingService");
    expect((JSON.parse(late?.properties ?? "{}") as PropRow).confidence).toBe(
      INJECT_CONFIDENCE_UNIQUE_TYPE
    );
    // The project-wide INJECTS rebuild must not lose the edges it re-derives.
    for (const edge of before) {
      expect(edges.some((e) => e.source === edge.source && e.target === edge.target)).toBe(true);
    }
    for (const edge of edges) {
      expect(scoped.raw("SELECT id FROM nodes WHERE id = ?", edge.target)).toHaveLength(1);
    }
    scoped.close();
  });
});

describe("the query layer surfaces confidence", () => {
  it("projects the field on injections and routes", () => {
    const injections = findInjections(store, { limit: 50 });
    expect(injections.length).toBeGreaterThan(0);
    for (const edge of injections) expect(typeof edge.confidence).toBe("number");

    const routes = findRoutes(store, { limit: 50 });
    expect(routes.length).toBeGreaterThan(0);
    for (const edge of routes) expect(typeof edge.confidence).toBe("number");
  });
});
