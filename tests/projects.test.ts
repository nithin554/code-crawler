import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { PluginProjects } from "../src/projects.js";
import { createServer } from "../src/server.js";

let tmp: string;
const managers: PluginProjects[] = [];

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
});
