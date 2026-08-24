import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphStore } from "./graph/store.js";
import type { Config } from "./config.js";
import { NODE_KINDS, EDGE_KINDS } from "./graph/schema.js";
import { crawlProject } from "./crawler.js";
import {
  getCallers,
  getCallees,
  tracePath,
  getSubgraph,
  searchSymbols,
  suggestSymbols,
  type SymbolRef,
} from "./graph/queries.js";
import { loadConfig } from "./config.js";

/**
 * MCP server surface for code-crawler.
 *
 * Thin tool handlers: every tool delegates to the graph/queries/crawler layers
 * and formats the result as JSON text. Line numbers are converted from the
 * internal 0-based convention to 1-based for LLM consumption.
 */

export const SERVER_NAME = "code-crawler";
export const SERVER_VERSION = "0.1.0";

export function createServer(store: GraphStore, config: Config): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const text = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  const line = (n: number | undefined): number | undefined =>
    typeof n === "number" ? n + 1 : undefined;

  const ref = (s: SymbolRef) => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    name: s.name,
    kind: s.kind,
    filePath: s.filePath,
  });

  const notFound = (symbol: string) => {
    const suggestions = suggestSymbols(store, symbol);
    return text({
      error: `symbol "${symbol}" not found in the index`,
      suggestions: suggestions.map(ref),
      hint: "Run crawl_project first, or use search_symbols for fuzzy lookup.",
    });
  };

  // ------------------------------------------------------------------ tools

  server.tool(
    "crawl_project",
    "Index a project directory into the codebase graph. Idempotent: re-crawling refreshes the index; files that disappeared are removed. Returns counts of files, nodes, edges, and resolved/unresolved call sites.",
    {
      path: z.string().describe("Absolute path to the project root directory to index."),
      language: z
        .string()
        .optional()
        .describe("Force a parser language (e.g. 'java'). Defaults to file-extension detection."),
      fileFilter: z
        .string()
        .optional()
        .describe("Optional substring filter: only index files whose path contains this string."),
    },
    async ({ path: projectPath, language, fileFilter }) => {
      try {
        const result = await crawlProject(store, projectPath, config.excludeDirs, {
          language,
          fileFilter,
        });
        return text({
          ok: true,
          ...result,
        });
      } catch (err) {
        return text({ ok: false, error: (err as Error).message });
      }
    }
  );

  server.tool(
    "index_status",
    "Report the current state of the index: node/edge/file counts and the last crawl timestamp.",
    {},
    async () => {
      const stats = store.stats();
      const projectPath = store.getMeta("last_project_path");
      return text({ ok: true, ...stats, projectPath });
    }
  );

  server.tool(
    "search_symbols",
    "Fuzzy-lookup symbols (classes, methods, fields, files) by name or fully-qualified name. Use this to find the exact symbol id before tracing calls.",
    {
      query: z.string().describe("Partial name or FQN, e.g. 'OrderService' or 'place'."),
      kind: z
        .enum(NODE_KINDS)
        .optional()
        .describe("Restrict results to a node kind (class, method, field, ...)."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
    },
    async ({ query, kind, limit }) => {
      const results = searchSymbols(store, query, { kind, limit });
      return text({
        query,
        count: results.length,
        results: results.map(ref),
      });
    }
  );

  server.tool(
    "get_node",
    "Get metadata and source location for a single symbol by id or qualified name.",
    {
      qualified_name: z
        .string()
        .describe("Symbol id or qualified name, e.g. 'com.acme.OrderService#place'."),
    },
    async ({ qualified_name }) => {
      const node = store.getNode(qualified_name) ?? store.getNodeByQualifiedName(qualified_name);
      if (!node) return notFound(qualified_name);
      return text({
        id: node.id,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath,
        properties: {
          ...node.properties,
          startLine: line(node.properties.startLine as number),
          endLine: line(node.properties.endLine as number),
        },
      });
    }
  );

  server.tool(
    "get_callers",
    "Find every symbol that calls the given symbol, directly or transitively (the call graph above it).",
    {
      symbol: z.string().describe("Method/constructor id or qualified name."),
      transitive: z.boolean().optional().describe("Include transitive callers (default true)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Traversal depth cap."),
      limit: z.number().int().min(1).max(500).optional().describe("Max callers returned."),
    },
    async ({ symbol, transitive, max_depth, limit }) => {
      const result = getCallers(store, symbol, { transitive, maxDepth: max_depth, limit });
      if (!result) return notFound(symbol);
      return text({
        target: ref(result.target),
        callers: result.callers.map((c) => ({
          caller: ref(c.caller),
          depth: c.depth,
          callSiteLine: line(c.callSiteLine),
        })),
      });
    }
  );

  server.tool(
    "get_callees",
    "Find every symbol the given symbol calls, directly or transitively (the call graph below it).",
    {
      symbol: z.string().describe("Method/constructor id or qualified name."),
      transitive: z.boolean().optional().describe("Include transitive callees (default true)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Traversal depth cap."),
      limit: z.number().int().min(1).max(500).optional().describe("Max callees returned."),
    },
    async ({ symbol, transitive, max_depth, limit }) => {
      const result = getCallees(store, symbol, { transitive, maxDepth: max_depth, limit });
      if (!result) return notFound(symbol);
      return text({
        source: ref(result.source),
        callees: result.callees.map((c) => ({
          callee: ref(c.callee),
          depth: c.depth,
          callSiteLine: line(c.callSiteLine),
        })),
      });
    }
  );

  server.tool(
    "trace_path",
    "Find static call paths between two symbols. Paths follow CALLS edges; shortest paths are returned first.",
    {
      source: z.string().describe("Starting symbol id or qualified name."),
      target: z.string().describe("Destination symbol id or qualified name."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Maximum path length."),
      limit: z.number().int().min(1).max(100).optional().describe("Max paths returned (default 10)."),
    },
    async ({ source, target, max_depth, limit }) => {
      const paths = tracePath(store, source, target, { maxDepth: max_depth, limit });
      if (!paths) return notFound(source);
      return text({
        source,
        target,
        pathCount: paths.length,
        paths: paths.map((p) => ({
          length: p.length,
          path: p.path,
        })),
      });
    }
  );

  server.tool(
    "get_subgraph",
    "Extract the neighborhood around a symbol across any edge kinds — for visualization and understanding the local shape of the graph.",
    {
      symbol: z.string().describe("Center symbol id or qualified name."),
      radius: z.number().int().min(1).max(6).optional().describe("Hop radius (default 2)."),
      edge_kinds: z
        .array(z.enum(EDGE_KINDS))
        .optional()
        .describe("Restrict which edge kinds to follow."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max nodes in the subgraph."),
    },
    async ({ symbol, radius, edge_kinds, limit }) => {
      const result = getSubgraph(store, symbol, { radius, edgeKinds: edge_kinds, limit });
      if (!result.center) return notFound(symbol);
      return text({
        center: ref(result.center),
        nodeCount: result.nodes.length,
        nodes: result.nodes.map(ref),
        edges: result.edges.map((e) => ({
          ...e,
          callSiteLine: line(e.callSiteLine),
        })),
      });
    }
  );

  server.tool(
    "get_schema",
    "Describe the property-graph model: node kinds, edge kinds, and the id scheme.",
    {},
    async () => {
      return text({
        nodeKinds: NODE_KINDS,
        edgeKinds: EDGE_KINDS,
        idScheme: {
          type: "com.acme.Foo",
          method: "com.acme.Foo#run",
          constructor: "com.acme.Foo#<init>",
          field: "com.acme.Foo$repo",
          import: "__import__:com.acme.Foo",
          unknown: "__unknown__:System.out.println",
        },
        lineNumbers: "1-based in tool output",
      });
    }
  );

  server.tool(
    "clear_index",
    "Wipe the entire graph database. Use with caution — you must crawl_project again afterwards.",
    {},
    async () => {
      store.clearAll();
      return text({ ok: true, cleared: true });
    }
  );

  // ------------------------------------------------------------- resources

  server.registerResource("graph-schema", "codecrawler://schema", {
    title: "Graph schema",
    description: "Node and edge kinds used by the codebase property graph.",
  }, async () => ({
    contents: [
      {
        uri: "codecrawler://schema",
        text: JSON.stringify(
          {
            nodeKinds: NODE_KINDS,
            edgeKinds: EDGE_KINDS,
            idScheme: {
              type: "com.acme.Foo",
              method: "com.acme.Foo#run",
              constructor: "com.acme.Foo#<init>",
              field: "com.acme.Foo$repo",
              import: "__import__:com.acme.Foo",
              unknown: "__unknown__:System.out.println",
            },
          },
          null,
          2
        ),
      },
    ],
  }));

  server.registerResource("index-status", "codecrawler://status", {
    title: "Index status",
    description: "Current index summary (nodes, edges, files, last crawl).",
  }, async () => {
    const stats = store.stats();
    return {
      contents: [
        {
          uri: "codecrawler://status",
          text: JSON.stringify(
            {
              ...stats,
              projectPath: store.getMeta("last_project_path"),
            },
            null,
            2
          ),
        },
      ],
    };
  });

  // --------------------------------------------------------------- prompts

  server.prompt("trace-call-path", "Given two symbols, trace every static call path between them.", {
    from: z.string().describe("Starting symbol"),
    to: z.string().describe("Destination symbol"),
  }, async ({ from, to }) => {
    const paths = tracePath(store, from, to, { limit: 10 });
    if (!paths || paths.length === 0) {
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text:
                `No static call path was found from \`${from}\` to \`${to}\`. ` +
                `Use \`search_symbols\` to confirm both symbols exist, and ` +
                `\`get_subgraph\` on each to inspect their neighborhoods.`,
            },
          },
        ],
      };
    }
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text:
              `Here are the static call paths from \`${from}\` to \`${to}\`:\n\n` +
              paths
                .map((p, i) => `${i + 1}. ${p.path.join(" -> ")}`)
                .join("\n") +
              `\n\nUse \`get_callers\` or \`get_callees\` on intermediate symbols to explore further.`,
          },
        },
      ],
    };
  });

  return server;
}

export { loadConfig };
