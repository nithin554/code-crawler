#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { GraphStore } from "./graph/store.js";
import { crawlProject } from "./crawler.js";
import { createServer } from "./server.js";
import { searchSymbols } from "./graph/queries.js";

/**
 * code-crawler CLI:
 *   codecrawler serve            start the MCP server over stdio (default)
 *   codecrawler crawl <path>     index a project into the graph database
 *   codecrawler status           show index summary
 *   codecrawler query <symbol>   fuzzy-lookup a symbol
 */

function usage(): void {
  console.log(`code-crawler — static call tracing over a codebase property graph

Usage:
  codecrawler serve              Start the MCP server over stdio (default)
  codecrawler crawl <path>       Index a project into the graph database
  codecrawler status             Show index summary
  codecrawler query <symbol>     Fuzzy-lookup a symbol

Environment:
  CODECRAWLER_DB               Database path (default ~/.code-crawler/index.db)
  CODECRAWLER_EXCLUDE_DIRS     Comma-separated dirs to skip during crawl
  CODECRAWLER_DEFAULT_LIMIT    Default result limit for list queries
  CODECRAWLER_MAX_DEPTH        Traversal depth cap
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
      const target = rest[0];
      if (!target) {
        console.error("code-crawler: missing <path> argument\n");
        usage();
        process.exitCode = 1;
        break;
      }
      const store = makeStore(config);
      try {
        const result = await crawlProject(store, target, config.excludeDirs);
        console.error(
          `code-crawler: indexed ${result.filesParsed}/${result.filesScanned} files ` +
            `(${result.nodes} nodes, ${result.edges} edges, ` +
            `${result.resolvedCalls} resolved / ${result.unresolvedCalls} unresolved calls) ` +
            `in ${result.durationMs}ms`
        );
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

const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("/dist/index.js"));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
