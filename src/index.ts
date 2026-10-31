#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Config, loadConfig } from "./config.js";
import { crawlProject } from "./crawler.js";
import { searchSymbols } from "./graph/queries.js";
import { GraphStore } from "./graph/store.js";
import {
  PluginProjects,
  pluginDataDir,
  pluginModeFromEnv,
  pluginRootFromEnv,
  type StoreSource,
} from "./projects.js";
import { createServer } from "./server.js";

/**
 * code-crawler CLI:
 *   codecrawler serve            start the MCP server over stdio (default)
 *   codecrawler crawl <path>     index a project into the graph database
 *   codecrawler status           show index summary
 *   codecrawler query <symbol>   fuzzy-lookup a symbol
 */

function usage(): void {
  console.log(`code-crawler — static + dynamic call tracing over a codebase property graph

Usage:
  codecrawler serve              Start the MCP server over stdio (default)
  codecrawler crawl <path>       Index a project into the graph database
  codecrawler crawl <path> --force
                                 Re-parse every file, ignoring cached metadata
  codecrawler status             Show index summary
  codecrawler query <symbol>     Fuzzy-lookup a symbol

Environment:
  CODECRAWLER_DB               Database path (default <project>/.code-crawler/index.db)
  CODECRAWLER_EXCLUDE_DIRS     Comma-separated dirs to skip during crawl
  CODECRAWLER_DEFAULT_LIMIT    Default result limit for list queries
  CODECRAWLER_MAX_DEPTH        Traversal depth cap
  CODECRAWLER_MAX_FILE_BYTES   Skip source files larger than this (default 1000000)
  CODECRAWLER_RESPECT_GITIGNORE Honor .gitignore during crawl (default true)
  CODECRAWLER_PLUGIN           Plugin mode: one database per project (set by plugin manifests)
  CODECRAWLER_PLUGIN_ROOT      Plugin install directory, never indexed as a project
  CODECRAWLER_PLUGIN_DATA      Writable plugin directory for the fallback database
`);
}

function makeStore(config: Config): GraphStore {
  return new GraphStore(config.dbPath, {
    maxDepth: config.maxDepth,
    defaultLimit: config.defaultLimit,
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "serve": {
      const config = loadConfig();
      // A plugin client starts the server inside the plugin directory. Pick one
      // database per project instead of binding to that directory. An explicit
      // CODECRAWLER_DB still wins and keeps the CLI's fixed-file behavior.
      const pluginRoot = pluginModeFromEnv() ? pluginRootFromEnv() : undefined;
      const projects = pluginModeFromEnv()
        ? new PluginProjects({
            config,
            pluginRoot,
            dataDir: pluginDataDir(pluginRoot),
            makeStore,
            log: (message) => console.error(`code-crawler: ${message}`),
          })
        : undefined;
      const storeConfig = projects ? { ...config, dbPath: projects.fallbackDatabasePath } : config;
      // Plugin mode opens the fallback database only when no project is ever
      // detected, so merely starting the server writes no database file.
      const store: StoreSource = projects ? () => projects.fallbackStore() : makeStore(storeConfig);
      const server = createServer(store, storeConfig, { projects });
      const transport = new StdioServerTransport();
      // Release SQLite handles (and checkpoint their WAL files) on the way out.
      // `exit` is synchronous and does not suppress the default signal behavior
      // the way a SIGINT/SIGTERM listener would.
      transport.onclose = () => projects?.close();
      if (projects) process.once("exit", () => projects.close());
      console.error(
        projects
          ? "code-crawler: MCP server ready (plugin mode: one database per project)"
          : `code-crawler: MCP server ready (db: ${config.dbPath})`
      );
      await server.connect(transport);
      break;
    }
    case "crawl": {
      const force = rest.includes("--force");
      const target = rest.find((arg) => !arg.startsWith("--"));
      if (!target) {
        console.error("code-crawler: missing <path> argument\n");
        usage();
        process.exitCode = 1;
        break;
      }
      // The indexed path owns the database, so crawling two projects never shares a file.
      const config = loadConfig({ projectRoot: target });
      const store = makeStore(config);
      try {
        let lastBucket = -1;
        const result = await crawlProject(store, target, config.excludeDirs, {
          respectGitignore: config.respectGitignore,
          maxFileBytes: config.maxFileBytes,
          force,
          onProgress: (progress) => {
            const percent =
              progress.total === 0 ? 100 : Math.floor((progress.processed / progress.total) * 100);
            const bucket = Math.floor(percent / 10);
            if (bucket === lastBucket) return;
            lastBucket = bucket;
            console.error(
              `code-crawler: ${progress.phase} ${percent}% (${progress.processed}/${progress.total})`
            );
          },
        });
        console.error(
          `code-crawler: indexed ${result.filesParsed}/${result.filesScanned} files ` +
            `(${result.nodes} nodes, ${result.edges} edges, ` +
            `${result.resolvedCalls} resolved / ${result.unresolvedCalls} unresolved calls) ` +
            `in ${result.durationMs}ms`
        );
        if (result.filesSkipped > 0) {
          console.error(
            `code-crawler: skipped ${result.filesSkipped} file(s) (too large or binary)`
          );
        }
        for (const failure of result.parseErrors.slice(0, 10)) {
          console.error(`code-crawler: parse failed: ${failure}`);
        }
        if (result.parseErrors.length > 10) {
          console.error(
            `code-crawler: ...and ${result.parseErrors.length - 10} more parse failure(s)`
          );
        }
      } catch (err) {
        console.error(`code-crawler: ${(err as Error).message}`);
        process.exitCode = 1;
      } finally {
        store.close();
      }
      break;
    }
    case "status": {
      const config = loadConfig();
      const store = makeStore(config);
      const stats = store.stats();
      console.log(
        JSON.stringify(
          {
            db: config.dbPath,
            nodes: stats.nodes,
            edges: stats.edges,
            files: stats.files,
            lastCrawl: stats.lastCrawl,
            projectPath: store.getMeta("last_project_path"),
          },
          null,
          2
        )
      );
      store.close();
      break;
    }
    case "query": {
      const symbol = rest[0];
      if (!symbol) {
        console.error("code-crawler: missing <symbol> argument\n");
        usage();
        process.exitCode = 1;
        break;
      }
      const config = loadConfig();
      const store = makeStore(config);
      const results = searchSymbols(store, symbol, { limit: config.defaultLimit });
      if (results.length === 0) {
        console.log(`code-crawler: no symbols matching "${symbol}"`);
      } else {
        console.log(
          JSON.stringify(
            results.map((r) => ({
              qualifiedName: r.qualifiedName,
              kind: r.kind,
              name: r.name,
              file: r.filePath,
            })),
            null,
            2
          )
        );
      }
      store.close();
      break;
    }
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`code-crawler: unknown command "${cmd}"\n`);
      usage();
      process.exitCode = 1;
  }
}

/**
 * Compare the invoked script path with this module's URL. Resolving both to
 * native filesystem paths keeps the check correct on Windows (backslashes,
 * drive letters) and when the CLI is reached through a symlink-free bin shim.
 */
export function isEntrypoint(
  entry: string | undefined,
  moduleUrl: string = import.meta.url
): boolean {
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
