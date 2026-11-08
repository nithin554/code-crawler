import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { findInjections } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

const FIXTURES = path.join(__dirname, "fixtures", "python", "fastapi-inject");

interface EdgeRow {
  source: string;
  target: string;
  properties: string;
}

let store: GraphStore;
let injections: EdgeRow[];

function edgesOf(kind: string): EdgeRow[] {
  return store.raw<EdgeRow>(
    "SELECT source, target, properties FROM edges WHERE kind = ? ORDER BY source, target",
    kind
  );
}

/** `owner -> target` pairs for every INJECTS edge. */
function pairs(): string[] {
  return injections.map((e) => `${e.source} -> ${e.target}`);
}

function propsOf(source: string, target: string): Record<string, unknown> {
  const edge = injections.find((e) => e.source === source && e.target === target);
  return edge ? JSON.parse(edge.properties) : {};
}

beforeAll(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  await crawlProject(store, FIXTURES, loadConfig().excludeDirs, {});
  injections = edgesOf("INJECTS");
});

afterAll(() => {
  store.close();
});

describe("FastAPI dependency aliases", () => {
  it("resolves an imported alias to the provider callable, not the base type", () => {
    expect(pairs()).toContain("module:app.routes.users#read_users -> module:app.deps#get_db");
  });

  it("follows an alias whose provider is itself dependency-injected", () => {
    expect(pairs()).toContain(
      "module:app.routes.users#read_me -> module:app.deps#get_current_user"
    );
  });

  it("resolves an alias used inside a plain, non-route function", () => {
    expect(pairs()).toContain("module:app.deps#get_current_user -> module:app.deps#get_db");
    expect(pairs()).toContain(
      "module:app.deps#require_superuser -> module:app.deps#get_current_user"
    );
  });

  it("marks alias-derived edges as inferred", () => {
    expect(propsOf("module:app.routes.users#read_users", "module:app.deps#get_db")).toMatchObject({
      injectedName: "session",
      framework: "fastapi",
      inferred: true,
    });
  });
});

describe("FastAPI decorator-level dependencies", () => {
  it("records a `dependencies=[...]` guard that no parameter names", () => {
    expect(pairs()).toContain(
      "module:app.routes.admin#start_maintenance -> module:app.deps#require_superuser"
    );
  });

  it("keeps the guard edge distinct from an inferred parameter dependency", () => {
    const props = propsOf(
      "module:app.routes.admin#start_maintenance",
      "module:app.deps#require_superuser"
    );
    expect(props.inferred).toBeUndefined();
    expect(props.injectedName).toBe("dependencies");
  });

  it("still serves the route under the router prefix", () => {
    const routes = store.raw<{ source: string; properties: string }>(
      "SELECT source, properties FROM edges WHERE kind = 'ROUTES'"
    );
    const served = routes
      .map((r) => JSON.parse(r.properties) as { path?: string })
      .map((p) => p.path);
    expect(served).toContain("/admin/maintenance/");
  });
});

describe("FastAPI dependency negatives", () => {
  it("does not turn a project type parameter into a dependency", () => {
    const fromItem = injections.filter((e) => e.source.includes("#read_item"));
    expect(fromItem.map((e) => e.target)).not.toContain("module:app.models#Item");
    expect(fromItem).toEqual([]);
  });

  it("ignores aliases in a module that imports no framework", () => {
    expect(injections.filter((e) => e.source.startsWith("module:plain."))).toEqual([]);
  });

  it("invents no unknown-target injection nodes", () => {
    expect(injections.filter((e) => e.target.startsWith("__inject__:"))).toEqual([]);
  });
});

describe("FastAPI dependency aliases survive an incremental crawl", () => {
  let temp: string;
  let incremental: GraphStore;

  const pairsIn = (s: GraphStore): string[] =>
    findInjections(s)
      .map((i) => `${i.source.id} -> ${i.target.id}`)
      .sort();

  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-fastapi-"));
    fs.cpSync(FIXTURES, temp, { recursive: true });
    incremental = new GraphStore(":memory:", { maxDepth: 10 });
    incremental.clearAll();
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
  });

  afterAll(() => {
    incremental.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("replays alias edges from the parse cache unchanged", async () => {
    const first = pairsIn(incremental);
    expect(first).toContain("module:app.routes.users#read_me -> module:app.deps#get_current_user");

    // A Map field flattens to {} through JSON, so an unpacked alias map would
    // silently drop every alias edge on the second crawl.
    const again = await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
    expect(again.filesUnchanged).toBeGreaterThan(0);
    expect(pairsIn(incremental)).toEqual(first);
  });

  it("rebuilds the edge when the alias changes provider", async () => {
    const deps = path.join(temp, "app", "deps.py");
    const source = fs.readFileSync(deps, "utf8");
    fs.writeFileSync(
      deps,
      source.replace(
        "CurrentUser = Annotated[User, Depends(get_current_user)]",
        "CurrentUser = Annotated[User, Depends(require_superuser)]"
      )
    );
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
    const after = pairsIn(incremental);
    expect(after).toContain("module:app.routes.users#read_me -> module:app.deps#require_superuser");
    expect(after).not.toContain(
      "module:app.routes.users#read_me -> module:app.deps#get_current_user"
    );
  });
});
