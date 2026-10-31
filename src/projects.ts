import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Config, databasePathFor, findProjectRoot } from "./config.js";
import { GraphStore } from "./graph/store.js";

/**
 * Plugin installs start the server inside the plugin directory, which is not the
 * user's checkout. The CLI can rely on the process cwd (and `CODECRAWLER_DB` for
 * one fixed file); a plugin server must instead pick a database per project, the
 * same `<project>/.code-crawler/index.db` the CLI would use.
 *
 * Project identity comes from, in order:
 *   1. the path passed to `crawl_project`,
 *   2. the client's workspace roots (`roots/list`, when exposed),
 *   3. the project this session already selected,
 *   4. the process cwd, when it is a real project and not the plugin root.
 *
 * The selection is session state: one manager per MCP server connection, never a
 * pointer file shared by every client session. Two sessions in different projects
 * therefore cannot steer each other's database.
 */

export type StoreFactory = (config: Config) => GraphStore;

export interface PluginProjectOptions {
  config: Config;
  /** Directory the plugin was installed into; never indexed as a project. */
  pluginRoot?: string;
  /** Writable directory for the fallback database. */
  dataDir?: string;
  makeStore?: StoreFactory;
  /** Resolve the process cwd; injectable for tests. */
  cwd?: () => string;
  log?: (message: string) => void;
}

function isInside(candidate: string, ancestor: string): boolean {
  const relative = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A plugin manifest owns this directory when it carries both manifest files. */
function looksLikePluginRoot(dir: string): boolean {
  return (
    (fs.existsSync(path.join(dir, "plugin.json")) && fs.existsSync(path.join(dir, "mcp.json"))) ||
    fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))
  );
}

/** `CODECRAWLER_PLUGIN=1` opts into per-project resolution. */
export function pluginModeFromEnv(): boolean {
  // An explicit database means "use this one file", exactly like the CLI.
  return process.env.CODECRAWLER_PLUGIN === "1" && !process.env.CODECRAWLER_DB;
}

/**
 * Plugin root from the client placeholder (`${PLUGIN_ROOT}` /
 * `${CLAUDE_PLUGIN_ROOT}`). An unexpanded placeholder falls back to the cwd,
 * but only when that cwd really looks like a plugin root — otherwise the client
 * launched the server inside a project and the cwd is what we want.
 */
export function pluginRootFromEnv(cwd: string = process.cwd()): string | undefined {
  const raw = process.env.CODECRAWLER_PLUGIN_ROOT;
  if (raw && !raw.includes("${") && path.isAbsolute(raw)) return path.resolve(raw);
  return looksLikePluginRoot(cwd) ? cwd : undefined;
}

/**
 * Writable plugin data directory for the no-project fallback database. Clients
 * substitute `${PLUGIN_DATA}` / `${CLAUDE_PLUGIN_DATA}`; without it, use a
 * stable temp directory keyed by the plugin root.
 */
export function pluginDataDir(pluginRoot?: string): string {
  const raw = process.env.CODECRAWLER_PLUGIN_DATA;
  if (raw && !raw.includes("${") && path.isAbsolute(raw)) return path.resolve(raw);
  const seed = pluginRoot ?? process.cwd();
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), "code-crawler-plugin", digest);
}

export class PluginProjects {
  private readonly config: Config;
  private readonly makeStore: StoreFactory;
  private readonly pluginRoot?: string;
  private readonly dataDir: string;
  private readonly cwd: () => string;
  private readonly log: (message: string) => void;
  private activeRoot?: string;
  /** Open stores stay open until shutdown so a parallel tool call can finish. */
  private readonly stores = new Map<string, GraphStore>();
  private fallbackStore?: GraphStore;
  private rootsProvider?: () => Promise<string[]>;
  private cachedRoots?: string[];

  constructor(options: PluginProjectOptions) {
    this.config = options.config;
    this.makeStore =
      options.makeStore ??
      ((config) =>
        new GraphStore(config.dbPath, {
          maxDepth: config.maxDepth,
          defaultLimit: config.defaultLimit,
        }));
    this.pluginRoot = options.pluginRoot;
    this.dataDir = options.dataDir ?? path.join(os.tmpdir(), "code-crawler-plugin");
    this.cwd = options.cwd ?? (() => process.cwd());
    this.log = options.log ?? (() => {});
  }

  /** The database used until a project is known. */
  get fallbackDatabasePath(): string {
    return path.join(this.dataDir, "index.db");
  }

  /** Project whose database the current tool call uses (`undefined` = fallback). */
  get activeProjectRoot(): string | undefined {
    return this.activeRoot;
  }

  /** Route to the client's workspace roots. */
  setRootsProvider(provider: () => Promise<string[]>): void {
    this.rootsProvider = provider;
  }

  /** Drop the cached roots after `roots/list_changed`. */
  invalidateRoots(): void {
    this.cachedRoots = undefined;
  }

  /**
   * Store for one tool call. `explicitProjectPath` is the argument the caller
   * named (`crawl_project`), which always wins over roots and history.
   */
  async forCall(explicitProjectPath?: string): Promise<GraphStore> {
    const root = await this.resolveRoot(explicitProjectPath);
    if (root === undefined) return this.fallback();
    return this.open(root);
  }

  close(): void {
    for (const store of this.stores.values()) this.closeStore(store);
    this.stores.clear();
    this.closeStore(this.fallbackStore);
    this.fallbackStore = undefined;
    this.activeRoot = undefined;
  }

  private async resolveRoot(explicitProjectPath?: string): Promise<string | undefined> {
    if (explicitProjectPath !== undefined) {
      const absolute = path.resolve(this.cwd(), explicitProjectPath);
      if (!fs.existsSync(absolute)) return undefined;
      const start = fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
      return findProjectRoot(start) ?? start;
    }

    const roots = await this.roots();
    const usable: string[] = [];
    for (const root of roots) {
      const absolute = path.resolve(root);
      if (!fs.existsSync(absolute)) continue;
      if (this.pluginRoot && isInside(absolute, this.pluginRoot)) continue;
      const projectRoot = findProjectRoot(absolute) ?? absolute;
      if (!usable.includes(projectRoot)) usable.push(projectRoot);
    }
    if (usable.length > 0) {
      if (this.activeRoot && usable.includes(this.activeRoot)) return this.activeRoot;
      return usable[0];
    }

    if (this.activeRoot && fs.existsSync(this.activeRoot)) return this.activeRoot;

    const cwd = this.cwd();
    if (this.pluginRoot && isInside(cwd, this.pluginRoot)) return undefined;
    return findProjectRoot(cwd);
  }

  private async roots(): Promise<string[]> {
    if (this.cachedRoots) return this.cachedRoots;
    if (!this.rootsProvider) return [];
    try {
      this.cachedRoots = await this.rootsProvider();
    } catch {
      this.cachedRoots = [];
    }
    return this.cachedRoots;
  }

  private open(root: string): GraphStore {
    const resolved = path.resolve(root);
    const existing = this.stores.get(resolved);
    if (existing) {
      this.activeRoot = resolved;
      return existing;
    }
    const dbPath = databasePathFor(resolved);
    const store = this.makeStore({ ...this.config, dbPath });
    this.stores.set(resolved, store);
    this.activeRoot = resolved;
    this.log(`using project database ${dbPath}`);
    return store;
  }

  private fallback(): GraphStore {
    if (!this.fallbackStore) {
      this.fallbackStore = this.makeStore({ ...this.config, dbPath: this.fallbackDatabasePath });
      this.log(`no project detected; using ${this.fallbackDatabasePath}`);
    }
    return this.fallbackStore;
  }

  private closeStore(store: GraphStore | undefined): void {
    if (!store) return;
    try {
      store.close();
    } catch {
      // Closing is best effort; a failed close must not fail a tool call.
    }
  }
}

/**
 * Bind each tool call to a store through AsyncLocalStorage while every handler
 * keeps using one `GraphStore`-typed value. Concurrent calls cannot observe each
 * other's project, and a plain `createServer(store, config)` (tests, the CLI
 * fallback) resolves to `initial` unchanged.
 */
export function scopedStore(initial: GraphStore): {
  store: GraphStore;
  run: <T>(store: GraphStore, fn: () => T) => T;
} {
  const storage = new AsyncLocalStorage<GraphStore>();
  const store = new Proxy({} as GraphStore, {
    get(_target, property) {
      const active = storage.getStore() ?? initial;
      const value = Reflect.get(active as object, property, active);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(active)
        : value;
    },
  });
  return { store, run: (bound, fn) => storage.run(bound, fn) };
}
