import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { MAX_OPEN_STORES, PluginProjects } from "../src/projects.js";
import { createServer } from "../src/server.js";

let tmp: string;
const managers: PluginProjects[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-crawler-projects-"));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function testConfig(): Config {
  return {
    dbPath: path.join(tmp, "fallback.db"),
    excludeDirs: [],
    defaultLimit: 50,
    maxDepth: 10,
    maxFileBytes: 1_000_000,
    respectGitignore: true,
    helpfulErrors: true,
  };
}

function project(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

function makeProjects(cwd: string): PluginProjects {
  const projects = new PluginProjects({
    config: testConfig(),
    pluginRoot: path.join(tmp, "plugin"),
    dataDir: path.join(tmp, "data"),
    cwd: () => cwd,
  });
  managers.push(projects);
  return projects;
}

describe("per-project databases", () => {
  it("stores a crawl path's graph inside that project", async () => {
    const app = project("app");
    const projects = makeProjects(path.join(tmp, "unrelated"));

    const store = await projects.forCall(app);
    store.setMeta("marker", "app");

    expect(projects.activeProjectRoot).toBe(path.resolve(app));
    expect(fs.existsSync(path.join(app, ".code-crawler", "index.db"))).toBe(true);
    expect(store.getMeta("marker")).toBe("app");
    projects.close();
  });

  it("gives a subdirectory the database of its enclosing project", async () => {
    const app = project("app");
    const nested = path.join(app, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const projects = makeProjects(path.join(tmp, "unrelated"));

    await projects.forCall(nested);

    expect(projects.activeProjectRoot).toBe(path.resolve(app));
    expect(fs.existsSync(path.join(app, ".code-crawler", "index.db"))).toBe(true);
    projects.close();
  });

  it("uses the client's workspace roots and ignores the plugin directory", async () => {
    const app = project("app");
    const pluginRoot = path.join(tmp, "plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const projects = new PluginProjects({
      config: testConfig(),
      pluginRoot,
      dataDir: path.join(tmp, "data"),
      cwd: () => path.join(tmp, "unrelated"),
    });
    managers.push(projects);
    projects.setRootsProvider(async () => [pluginRoot, app]);

    await projects.forCall();

    expect(projects.activeProjectRoot).toBe(path.resolve(app));
    projects.close();
  });

  it("switches databases between projects and reopens the previous one", async () => {
    const first = project("first");
    const second = project("second");
    const projects = makeProjects(path.join(tmp, "unrelated"));

    const firstStore = await projects.forCall(first);
    firstStore.setMeta("marker", "first");
    const secondStore = await projects.forCall(second);
    expect(secondStore.getMeta("marker")).toBeNull();
    // A parallel call may still be using the previous store.
    expect(firstStore.getMeta("marker")).toBe("first");

    const reopened = await projects.forCall(first);
    expect(reopened.getMeta("marker")).toBe("first");
    projects.close();
  });

  it("does not share the selected project between sessions", async () => {
    const app = project("app");
    const cwd = path.join(tmp, "unrelated");
    const first = makeProjects(cwd);
    await first.forCall(app);

    const second = makeProjects(cwd);
    second.setRootsProvider(async () => []);
    await second.forCall();

    expect(first.activeProjectRoot).toBe(path.resolve(app));
    expect(second.activeProjectRoot).toBeUndefined();
  });

  it("falls back to the plugin data directory when no project is known", async () => {
    const projects = makeProjects(path.join(tmp, "unrelated"));
    projects.setRootsProvider(async () => []);

    await projects.forCall();

    expect(projects.activeProjectRoot).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, "data", "index.db"))).toBe(true);
    projects.close();
  });

  it("does not create a database for a path that does not exist", async () => {
    const missing = path.join(tmp, "missing");
    const projects = makeProjects(path.join(tmp, "unrelated"));

    await projects.forCall(missing);

    expect(fs.existsSync(missing)).toBe(false);
    expect(projects.activeProjectRoot).toBeUndefined();
    projects.close();
  });
});

/** Track which databases were closed so eviction can be asserted. */
function countingProjects(cwd: string, closed: string[]): PluginProjects {
  const projects = new PluginProjects({
    config: testConfig(),
    dataDir: path.join(tmp, "data"),
    cwd: () => cwd,
    makeStore: (config) => {
      const store = new GraphStore(config.dbPath, {
        maxDepth: config.maxDepth,
        defaultLimit: config.defaultLimit,
      });
      const close = store.close.bind(store);
      store.close = () => {
        closed.push(config.dbPath);
        close();
      };
      return store;
    },
  });
  managers.push(projects);
  return projects;
}

describe("concurrency and resource handling", () => {
  it("shares one roots/list request between parallel tool calls", async () => {
    const app = project("app");
    const projects = makeProjects(path.join(tmp, "unrelated"));
    let calls = 0;
    projects.setRootsProvider(async () => {
      calls += 1;
      await sleep(10);
      return [app];
    });

    await Promise.all([projects.forCall(), projects.forCall(), projects.forCall()]);

    expect(calls).toBe(1);
  });

  it("does not cache roots that came back after roots/list_changed", async () => {
    const app = project("app");
    const projects = makeProjects(path.join(tmp, "unrelated"));
    let calls = 0;
    let respond: (roots: string[]) => void = () => {};
    projects.setRootsProvider(async () => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<string[]>((resolve) => {
          respond = resolve;
        });
      }
      return [app];
    });

    const pending = projects.forCall();
    await sleep(5);
    projects.invalidateRoots();
    respond([app]);
    await pending;

    await projects.forCall();
    expect(calls).toBe(2);
  });

  it("keeps open databases bounded and reopens an evicted one", async () => {
    const roots = Array.from({ length: MAX_OPEN_STORES + 4 }, (_, i) => project(`p${i}`));
    const closed: string[] = [];
    const projects = countingProjects(path.join(tmp, "unrelated"), closed);

    for (const root of roots) await projects.forCall(root);

    const dbFor = (root: string): string => path.join(root, ".code-crawler", "index.db");
    expect(closed.length).toBeGreaterThanOrEqual(roots.length - MAX_OPEN_STORES);
    expect(closed).not.toContain(dbFor(roots[roots.length - 1]));

    const reopened = await projects.forCall(roots[0]);
    reopened.setMeta("marker", "again");
    expect((await projects.forCall(roots[0])).getMeta("marker")).toBe("again");
    projects.close();
  });

  it("does not close a database a parallel call is still using", async () => {
    const busy = project("busy");
    const closed: string[] = [];
    const projects = countingProjects(path.join(tmp, "unrelated"), closed);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = projects.withCall(busy, async (store) => {
      store.setMeta("marker", "busy");
      await gate;
      return store.getMeta("marker");
    });
    await sleep(10);
    for (let i = 0; i < MAX_OPEN_STORES + 3; i++) await projects.forCall(project(`extra${i}`));

    expect(closed).not.toContain(path.join(busy, ".code-crawler", "index.db"));
    release();
    expect(await inFlight).toBe("busy");
    projects.close();
  });
});

describe("plugin server routing", () => {
  function parse(result: {
    content: Array<{ type: string; text?: string }>;
  }): Record<string, unknown> {
    const text = result.content.find((part) => part.type === "text")?.text;
    if (!text) throw new Error("tool returned no text");
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("routes crawl_project and later calls to the project's own database", async () => {
    const app = project("app");
    fs.mkdirSync(path.join(app, "src"));
    fs.writeFileSync(path.join(app, "src", "hello.ts"), "export function hello() { return 1; }\n");

    const config = testConfig();
    const initial = new GraphStore(":memory:", { maxDepth: 10 });
    const projects = makeProjects(path.join(tmp, "unrelated"));
    projects.setRootsProvider(async () => []);
    const server = createServer(initial, config, { projects });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const crawled = parse(
        await client.callTool({ name: "crawl_project", arguments: { path: app } })
      );
      expect(crawled.ok).toBe(true);

      const status = parse(await client.callTool({ name: "index_status", arguments: {} }));
      expect(status.projectPath).toBe(path.resolve(app));
      expect(fs.existsSync(path.join(app, ".code-crawler", "index.db"))).toBe(true);
    } finally {
      await client.close();
      projects.close();
      initial.close();
    }
  });

  it("traces the prompt against the project database, never the fallback", async () => {
    const app = project("app");
    fs.mkdirSync(path.join(app, "src"));
    fs.writeFileSync(
      path.join(app, "src", "math.ts"),
      "export function computeTotal() { return innerHelper(); }\n" +
        "export function innerHelper() { return 1; }\n"
    );

    const config = testConfig();
    const projects = makeProjects(path.join(tmp, "unrelated"));
    projects.setRootsProvider(async () => []);
    // Plugin mode hands the server a lazy fallback, so nothing may write it.
    const server = createServer(() => projects.fallbackStore(), config, { projects });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const crawled = parse(
        await client.callTool({ name: "crawl_project", arguments: { path: app } })
      );
      expect(crawled.ok).toBe(true);

      const prompt = await client.getPrompt({
        name: "trace-call-path",
        arguments: {
          from: "module:src.math#computeTotal",
          to: "module:src.math#innerHelper",
        },
      });
      const text = prompt.messages
        .map((message) => (message.content.type === "text" ? message.content.text : ""))
        .join("\n");
      expect(text).toContain("Here are the static call paths");
      expect(text).toContain("computeTotal");
      expect(fs.existsSync(path.join(tmp, "data", "index.db"))).toBe(false);
    } finally {
      await client.close();
      projects.close();
    }
  });
});
