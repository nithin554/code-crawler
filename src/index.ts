#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Config, loadConfig } from "./config.js";
import { crawlProject } from "./crawler.js";
import { searchSymbols } from "./graph/queries.js";
import { GraphStore } from "./graph/store.js";
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
  CODECRAWLER_DB               Database path (default ~/.code-crawler/index.db)
  CODECRAWLER_EXCLUDE_DIRS     Comma-separated dirs to skip during crawl
  CODECRAWLER_DEFAULT_LIMIT    Default result limit for list queries
  CODECRAWLER_MAX_DEPTH        Traversal depth cap
  CODECRAWLER_MAX_FILE_BYTES   Skip source files larger than this (default 1000000)
  CODECRAWLER_RESPECT_GITIGNORE Honor .gitignore during crawl (default true)
`);
}

function makeStore(config: Config): GraphStore {
  return new GraphStore(config.dbPath, {
    maxDepth: config.maxDepth,
    defaultLimit: config.defaultLimit,
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig();
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "serve": {
      const store = makeStore(config);
      const server = createServer(store, config);
      const transport = new StdioServerTransport();
      console.error(`code-crawler: MCP server ready (db: ${config.dbPath})`);
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
