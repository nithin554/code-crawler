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

/** A store, or a factory for one. Plugin mode passes a factory so simply
 * starting the server does not create a database file nobody asked for. */
export type StoreSource = GraphStore | (() => GraphStore);

/** Keep the number of open SQLite handles bounded in a long-lived session. */
export const MAX_OPEN_STORES = 8;

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
  /** Project roots with a tool call in flight; never evicted mid-call. */
  private readonly inUse = new Map<string, number>();
  private fallbackDb?: GraphStore;
  private rootsProvider?: () => Promise<string[]>;
  private cachedRoots?: string[];
  private rootsGeneration = 0;
  private rootsPending?: Promise<string[]>;

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
    this.rootsGeneration += 1;
  }

  /**
   * Store for one tool call. `explicitProjectPath` is the argument the caller
   * named (`crawl_project`), which always wins over roots and history.
   */
  async forCall(explicitProjectPath?: string): Promise<GraphStore> {
    return await this.withCall(explicitProjectPath, (store) => store);
  }

  /**
   * Resolve the store for one tool call, run `fn` against it, and release it.
   * Concurrency: the store is reference counted for the duration of the call,
   * so eviction never closes a database another call is still using.
   */
  async withCall<T>(
    explicitProjectPath: string | undefined,
    fn: (store: GraphStore) => T | Promise<T>
  ): Promise<T> {
    const root = await this.resolveRoot(explicitProjectPath);
    const store = root === undefined ? this.fallbackStore() : this.open(root);
    const key = root ?? "\u0000fallback";
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
    try {
      return await fn(store);
    } finally {
      const remaining = (this.inUse.get(key) ?? 1) - 1;
      if (remaining > 0) this.inUse.set(key, remaining);
      else this.inUse.delete(key);
    }
  }

  /** Release every SQLite handle (called on transport close and signals). */
  close(): void {
    for (const store of this.stores.values()) this.closeStore(store);
    this.stores.clear();
    this.inUse.clear();
    this.closeStore(this.fallbackDb);
    this.fallbackDb = undefined;
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
    // Share one in-flight `roots/list` between parallel tool calls, and drop the
    // result when `roots/list_changed` arrived while the request was running.
    if (!this.rootsPending) {
      const generation = this.rootsGeneration;
      const provider = this.rootsProvider;
      this.rootsPending = (async () => {
        try {
          return { generation, roots: await provider() };
        } catch {
          return { generation, roots: [] as string[] };
        }
      })().then(({ generation: seen, roots }) => {
        this.rootsPending = undefined;
        if (seen === this.rootsGeneration) this.cachedRoots = roots;
        return roots;
      });
    }
    return await this.rootsPending;
  }

  private open(root: string): GraphStore {
    const resolved = path.resolve(root);
    const existing = this.stores.get(resolved);
    if (existing) {
      // Refresh insertion order so eviction drops the least recently used handle.
      this.stores.delete(resolved);
      this.stores.set(resolved, existing);
      this.activeRoot = resolved;
      return existing;
    }
    const dbPath = databasePathFor(resolved);
    const store = this.makeStore({ ...this.config, dbPath });
    this.stores.set(resolved, store);
    this.activeRoot = resolved;
    this.log(`using project database ${dbPath}`);
    this.evictIdleStores(resolved);
    return store;
  }

  /** Close the least recently used handle, but only when no call is using it. */
  private evictIdleStores(keep: string): void {
    if (this.stores.size <= MAX_OPEN_STORES) return;
    for (const [root, store] of this.stores) {
      if (this.stores.size <= MAX_OPEN_STORES) return;
      if (root === keep || this.inUse.has(root)) continue;
      this.stores.delete(root);
      this.closeStore(store);
      this.log(`closed idle project database ${root}`);
    }
  }

  /**
   * Database used when no project can be identified (a chat with no workspace).
   * Created lazily: plugin mode must not write a database just by starting up.
   */
  fallbackStore(): GraphStore {
    if (!this.fallbackDb) {
      this.fallbackDb = this.makeStore({ ...this.config, dbPath: this.fallbackDatabasePath });
      this.log(`no project detected; using ${this.fallbackDatabasePath}`);
    }
    return this.fallbackDb;
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
 * other's project, and a plain `createServer(store, config)` (tests, the CLI)
 * resolves to `source` unchanged. A factory source is only called on first use,
 * so plugin mode writes no fallback database until a call needs it.
 */
export function scopedStore(source: StoreSource): {
  store: GraphStore;
  run: <T>(store: GraphStore, fn: () => T) => T;
} {
  const storage = new AsyncLocalStorage<GraphStore>();
  let lazy: GraphStore | undefined;
  const initial = (): GraphStore => {
    if (typeof source !== "function") return source;
    lazy ??= source();
    return lazy;
  };
  const store = new Proxy({} as GraphStore, {
    get(_target, property) {
      const active = storage.getStore() ?? initial();
      const value = Reflect.get(active as object, property, active);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(active)
        : value;
    },
  });
  return { store, run: (bound, fn) => storage.run(bound, fn) };
}
