import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { crawlProject } from "./crawler.js";
import { applyBudget, pageMeta } from "./graph/budget.js";
import {
  explainSymbol,
  exportGraph,
  findCycles,
  findUnresolved,
  impactAnalysis,
  unresolvedForNode,
} from "./graph/insights.js";
import {
  deadCode,
  externalDependencies,
  findAnnotated,
  findEntryPoints,
  findImplementations,
  findInjections,
  findReflections,
  findRoutes,
  getAspects,
  getCallees,
  getCallers,
  getDecorators,
  getSubgraph,
  hotspots,
  type SymbolRef,
  searchSymbols,
  suggestSymbols,
  traceExecution,
  tracePath,
  type WiringEdge,
} from "./graph/queries.js";
import { EDGE_KINDS, NODE_KINDS } from "./graph/schema.js";
import type { GraphStore } from "./graph/store.js";

/**
 * MCP server surface for code-crawler.
 *
 * Thin tool handlers: every tool delegates to the graph/queries/crawler layers
 * and formats the result as JSON text. Line numbers are converted from the
 * internal 0-based convention to 1-based for LLM consumption.
 */

export const SERVER_NAME = "code-crawler";
export const SERVER_VERSION = "0.1.0";

/** The subset of the MCP handler `extra` used for progress reporting. */
interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

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

  /** Project a framework-wiring edge (route, injection, reflection). */
  const wiring = (e: WiringEdge) => ({
    source: ref(e.source),
    target: ref(e.target),
    ...(e.httpMethod ? { httpMethod: e.httpMethod } : {}),
    ...(e.path ? { path: e.path } : {}),
    ...(e.framework ? { framework: e.framework } : {}),
    ...(e.mechanism ? { mechanism: e.mechanism } : {}),
    ...(e.injectedName ? { injectedName: e.injectedName } : {}),
    ...(e.external ? { external: true } : {}),
    ...(e.line !== undefined ? { line: line(e.line) } : {}),
  });

  const notFound = (symbol: string) => {
    const suggestions = suggestSymbols(store, symbol);
    return text({
      ok: false,
      error: `symbol "${symbol}" not found in the index`,
      suggestions: suggestions.map(ref),
      hint: "Run crawl_project first, or use search_symbols for fuzzy lookup.",
    });
  };

  const errorResult = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return text({
      ok: false,
      error: message,
      hint: "Check the tool arguments and the index state (index_status); if the index is from an older version, run clear_index and crawl again.",
    });
  };

  /**
   * Opt-in pagination parameters. When neither is supplied the response shape
   * is byte-identical to the pre-pagination shape.
   */
  const budgetParams = {
    max_tokens: z
      .number()
      .int()
      .min(100)
      .max(200000)
      .optional()
      .describe(
        "Soft cap on the estimated token cost of the returned list (about 4 characters per token). When the list does not fit, the response gains a `page` block carrying `nextCursor`."
      ),
    cursor: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Offset into the list; pass page.nextCursor from a previous response to continue."),
  };

  /**
   * Attach a `page` block and cut the list when the caller asked for a budget.
   * Counting keys keep reporting the full window size so clients can decide
   * whether to ask for the next page. Each tool keeps its own counting key name,
   * so a payload only gains `count` when it already had one.
   */
  const paged = <T>(
    payload: Record<string, unknown>,
    key: string,
    items: T[],
    args: { max_tokens?: number; cursor?: number }
  ): Record<string, unknown> => {
    if (args.max_tokens === undefined && args.cursor === undefined) return payload;
    const page = applyBudget(items, { maxTokens: args.max_tokens, cursor: args.cursor });
    const next: Record<string, unknown> = { ...payload, [key]: page.items, page: pageMeta(page) };
    if ("count" in payload) next.count = items.length;
    return next;
  };

  /**
   * Every handler shares one error boundary so MCP clients always receive the
   * same `{ ok, error, hint }` shape instead of a mix of throws and payloads.
   */
  const tool = <Args extends unknown[]>(
    name: string,
    description: string,
    paramsSchema: unknown,
    handler: (...args: Args) => unknown
  ): void => {
    const register = server.tool.bind(server) as unknown as (
      n: string,
      d: string,
      s: unknown,
      h: (...args: unknown[]) => unknown
    ) => void;
    register(name, description, paramsSchema, async (...args: unknown[]) => {
      try {
        return await handler(...(args as Args));
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  // ------------------------------------------------------------------ tools

  tool(
    "crawl_project",
    "Index a project directory into the codebase graph. Supports Java, Python, TypeScript, and JavaScript. Idempotent: a full re-crawl refreshes the index and removes files that disappeared. The index holds one project; indexing a different project fails until clear_index is called. Honors .gitignore and an optional .crawlerrc, skips files above CODECRAWLER_MAX_FILE_BYTES and binary files, and reports skipped files and parse errors. Scoped crawls (fileFilter or language) never remove files outside their scope and report pruned=false. Returns counts of files, nodes, edges, resolved/unresolved call sites, entry points, injections, reflections, and external dependencies.",
    {
      path: z.string().describe("Absolute path to the project root directory to index."),
      language: z
        .string()
        .optional()
        .describe(
          "Restrict indexing to one parser language: 'java', 'python', 'typescript', or 'javascript'. Files whose extension does not belong to that language are skipped. Defaults to file-extension detection."
        ),
      fileFilter: z
        .string()
        .optional()
        .describe("Optional substring filter: only index files whose path contains this string."),
    },
    async ({ path: projectPath, language, fileFilter }, rawExtra) => {
      const extra = rawExtra as ProgressExtra;
      const progressToken = extra._meta?.progressToken;
      const step = (total: number) => Math.max(1, Math.floor(total / 100));
      const result = await crawlProject(store, projectPath, config.excludeDirs, {
        language,
        fileFilter,
        respectGitignore: config.respectGitignore,
        maxFileBytes: config.maxFileBytes,
        onProgress:
          progressToken === undefined
            ? undefined
            : (progress) => {
                if (
                  progress.processed !== progress.total &&
                  progress.processed % step(progress.total) !== 0
                ) {
                  return;
                }
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: progress.processed,
                      total: progress.total,
                      message: `${progress.phase} ${progress.processed}/${progress.total} files`,
                    },
                  })
                  .catch(() => undefined);
              },
      });
      return text({
        ok: true,
        ...result,
      });
    }
  );

  tool(
    "index_status",
    "Report the current state of the index: node/edge/file counts and the last crawl timestamp.",
    {},
    async () => {
      const stats = store.stats();
      const projectPath = store.getMeta("last_project_path");
      return text({ ok: true, ...stats, projectPath });
    }
  );

  tool(
    "search_symbols",
    "Fuzzy-lookup symbols (classes, methods, fields, files) by name or fully-qualified name. Use this to find the exact symbol id before tracing calls.",
    {
      query: z.string().describe("Partial name or FQN, e.g. 'OrderService' or 'place'."),
      kind: z
        .enum(NODE_KINDS)
        .optional()
        .describe("Restrict results to a node kind (class, method, field, ...)."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
      ...budgetParams,
    },
    async ({ query, kind, limit, max_tokens, cursor }) => {
      const results = searchSymbols(store, query, { kind, limit });
      const refs = results.map(ref);
      return text(
        paged({ query, count: refs.length, results: refs }, "results", refs, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "get_node",
    "Get metadata and source location for a single symbol by id or qualified name. Includes an `unresolved` block when the symbol has call sites the resolver could not bind, or when unresolved calls elsewhere point at it.",
    {
      qualified_name: z
        .string()
        .describe("Symbol id or qualified name, e.g. 'com.acme.OrderService#place'."),
    },
    async ({ qualified_name }) => {
      const node = store.getNode(qualified_name) ?? store.getNodeByQualifiedName(qualified_name);
      if (!node) return notFound(qualified_name);
      const unresolved = unresolvedForNode(store, node.id);
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
        ...(unresolved
          ? {
              unresolved: {
                callerCount: unresolved.outgoing.length,
                referencedByCount: unresolved.incoming.length,
                calls: unresolved.outgoing.map((c) => ({
                  target: c.targetLabel,
                  reason: c.reason,
                  line: line(c.line),
                })),
                referencedBy: unresolved.incoming.map((i) => ({
                  caller: ref(i.caller),
                  line: line(i.line),
                })),
              },
            }
          : {}),
      });
    }
  );

  tool(
    "get_callers",
    "Find every symbol that calls the given symbol, directly or transitively (the call graph above it). Optionally follow virtual-dispatch and aspect-advice edges for dynamic callers.",
    {
      symbol: z.string().describe("Method/constructor id or qualified name."),
      transitive: z.boolean().optional().describe("Include transitive callers (default true)."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Also follow DYNAMIC_DISPATCH edges (virtual/interface targets)."),
      include_advice: z
        .boolean()
        .optional()
        .describe("Also follow ADVISES edges (aspect advice methods)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Traversal depth cap."),
      limit: z.number().int().min(1).max(500).optional().describe("Max callers returned."),
      ...budgetParams,
    },
    async ({
      symbol,
      transitive,
      include_dynamic,
      include_advice,
      max_depth,
      limit,
      max_tokens,
      cursor,
    }) => {
      const result = getCallers(store, symbol, {
        transitive,
        includeDynamic: include_dynamic,
        includeAdvice: include_advice,
        maxDepth: max_depth,
        limit,
      });
      if (!result) return notFound(symbol);
      const callers = result.callers.map((c) => ({
        caller: ref(c.caller),
        depth: c.depth,
        callSiteLine: line(c.callSiteLine),
        edgeKind: c.edgeKind,
      }));
      return text(
        paged({ target: ref(result.target), count: callers.length, callers }, "callers", callers, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "get_callees",
    "Find every symbol the given symbol calls, directly or transitively (the call graph below it). Set include_dynamic to also follow virtual/interface dispatch targets.",
    {
      symbol: z.string().describe("Method/constructor id or qualified name."),
      transitive: z.boolean().optional().describe("Include transitive callees (default true)."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Also follow DYNAMIC_DISPATCH edges (virtual/interface targets)."),
      include_advice: z
        .boolean()
        .optional()
        .describe("Also follow ADVISES edges (aspect advice methods)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Traversal depth cap."),
      limit: z.number().int().min(1).max(500).optional().describe("Max callees returned."),
      ...budgetParams,
    },
    async ({
      symbol,
      transitive,
      include_dynamic,
      include_advice,
      max_depth,
      limit,
      max_tokens,
      cursor,
    }) => {
      const result = getCallees(store, symbol, {
        transitive,
        includeDynamic: include_dynamic,
        includeAdvice: include_advice,
        maxDepth: max_depth,
        limit,
      });
      if (!result) return notFound(symbol);
      const callees = result.callees.map((c) => ({
        callee: ref(c.callee),
        depth: c.depth,
        callSiteLine: line(c.callSiteLine),
        edgeKind: c.edgeKind,
      }));
      return text(
        paged({ source: ref(result.source), count: callees.length, callees }, "callees", callees, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "trace_path",
    "Find call paths between two symbols. Follows static CALLS edges by default; set include_dynamic/include_advice to also route through virtual dispatch and aspect advice.",
    {
      source: z.string().describe("Starting symbol id or qualified name."),
      target: z.string().describe("Destination symbol id or qualified name."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Also follow DYNAMIC_DISPATCH edges (virtual/interface targets)."),
      include_advice: z
        .boolean()
        .optional()
        .describe("Also follow ADVISES edges (aspect advice methods)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Maximum path length."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max paths returned (default 10)."),
      ...budgetParams,
    },
    async ({
      source,
      target,
      include_dynamic,
      include_advice,
      max_depth,
      limit,
      max_tokens,
      cursor,
    }) => {
      const paths = tracePath(store, source, target, {
        includeDynamic: include_dynamic,
        includeAdvice: include_advice,
        maxDepth: max_depth,
        limit,
      });
      if (!paths) return notFound(source);
      const mapped = paths.map((p) => ({
        length: p.length,
        path: p.path,
        edges: p.edges.map((e) => ({
          source: e.source,
          target: e.target,
          kind: e.kind,
          callSiteLine: line(e.callSiteLine),
        })),
      }));
      return text(
        paged({ source, target, pathCount: mapped.length, paths: mapped }, "paths", mapped, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "trace_execution",
    "Produce a dynamic execution trace from a symbol: follows static and virtual-dispatch calls and weaves in aspect advice. Steps show how each symbol was reached, including INTERCEPT hops where advice wraps a call.",
    {
      symbol: z.string().describe("Starting method or constructor id/qualified name."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Follow virtual/interface dispatch edges (default true)."),
      include_advice: z
        .boolean()
        .optional()
        .describe("Weave aspect advice into the trace (default true)."),
      max_depth: z.number().int().min(1).max(50).optional().describe("Traversal depth cap."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max steps returned."),
      ...budgetParams,
    },
    async ({ symbol, include_dynamic, include_advice, max_depth, limit, max_tokens, cursor }) => {
      const result = traceExecution(store, symbol, {
        includeDynamic: include_dynamic,
        includeAdvice: include_advice,
        maxDepth: max_depth,
        limit,
      });
      if (!result) return notFound(symbol);
      const steps = result.steps.map((s) => ({
        symbol: ref(s.symbol),
        depth: s.depth,
        via: s.via,
        callSiteLine: line(s.callSiteLine),
      }));
      return text(
        paged({ root: ref(result.root), stepCount: steps.length, steps }, "steps", steps, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "find_implementations",
    "Find every class/interface that implements or extends a type, directly or transitively. Use this to understand virtual dispatch candidates.",
    {
      symbol: z.string().describe("Interface or superclass id/qualified name."),
      max_depth: z.number().int().min(1).max(20).optional().describe("Hierarchy depth cap."),
      limit: z.number().int().min(1).max(500).optional().describe("Max implementations returned."),
      ...budgetParams,
    },
    async ({ symbol, max_depth, limit, max_tokens, cursor }) => {
      const result = findImplementations(store, symbol, { maxDepth: max_depth, limit });
      if (!result) return notFound(symbol);
      const implementations = result.implementations.map((i) => ({
        type: ref(i.type),
        depth: i.depth,
        via: i.via,
      }));
      return text(
        paged(
          {
            target: ref(result.target),
            implementationCount: implementations.length,
            implementations,
          },
          "implementations",
          implementations,
          { max_tokens, cursor }
        )
      );
    }
  );

  tool(
    "find_aspects",
    "List aspects with their advice methods (@Before/@After/@Around/...), pointcuts, and the methods each advice intercepts.",
    {
      limit: z.number().int().min(1).max(200).optional().describe("Max aspects returned."),
      ...budgetParams,
    },
    async ({ limit, max_tokens, cursor }) => {
      const aspects = getAspects(store, { limit });
      const mapped = aspects.map((a) => ({
        aspect: ref(a.aspect),
        advice: a.advice.map((adv) => ({
          method: ref(adv.method),
          adviceKind: adv.adviceKind,
          pointcut: adv.pointcut,
          advised: adv.advised.map(ref),
        })),
      }));
      return text(
        paged({ aspectCount: mapped.length, aspects: mapped }, "aspects", mapped, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "get_decorators",
    "Get the annotations/decorators applied to a symbol. Set include_members to also list decorators on its methods, constructors, and fields.",
    {
      symbol: z.string().describe("Symbol id or qualified name."),
      include_members: z
        .boolean()
        .optional()
        .describe("Include decorators on declared members (default false)."),
      ...budgetParams,
    },
    async ({ symbol, include_members, max_tokens, cursor }) => {
      const result = getDecorators(store, symbol, { includeMembers: include_members });
      if (!result) return notFound(symbol);
      const members = result.members.map((m) => ({
        symbol: ref(m.symbol),
        decorators: m.decorators.map((d) => ({ ...d, line: line(d.line) })),
      }));
      return text(
        paged(
          {
            symbol: ref(result.symbol),
            decorators: result.decorators.map((d) => ({
              ...d,
              line: line(d.line),
            })),
            members,
          },
          "members",
          members,
          { max_tokens, cursor }
        )
      );
    }
  );

  tool(
    "find_annotated",
    "Find every symbol annotated/decorated with a given annotation (simple name, @name, or FQN).",
    {
      annotation: z
        .string()
        .describe("Annotation name, e.g. 'Transactional', '@Aspect' or an FQN."),
      kind: z
        .enum(NODE_KINDS)
        .optional()
        .describe("Restrict results to a node kind (class, method, field, ...)."),
      limit: z.number().int().min(1).max(500).optional().describe("Max symbols returned."),
      ...budgetParams,
    },
    async ({ annotation, kind, limit, max_tokens, cursor }) => {
      const results = findAnnotated(store, annotation, { kind, limit });
      const symbols = results.map((r) => ({
        symbol: ref(r.symbol),
        annotation: r.annotation,
        line: line(r.line),
        arguments: r.arguments,
      }));
      return text(
        paged({ annotation, count: symbols.length, results: symbols }, "results", symbols, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "find_hotspots",
    "Rank methods/constructors by call volume (fan-in, fan-out, advice interceptions). Useful for prioritizing review or refactoring.",
    {
      limit: z.number().int().min(1).max(200).optional().describe("Max hotspots returned."),
      min_fan_in: z.number().int().min(0).optional().describe("Minimum incoming call count."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Count dynamic-dispatch callers too (default true)."),
      ...budgetParams,
    },
    async ({ limit, min_fan_in, include_dynamic, max_tokens, cursor }) => {
      const results = hotspots(store, {
        limit,
        minFanIn: min_fan_in,
        includeDynamic: include_dynamic,
      });
      const list = results.map((h) => ({
        symbol: ref(h.symbol),
        fanIn: h.fanIn,
        fanOut: h.fanOut,
        adviceCount: h.adviceCount,
      }));
      return text(
        paged({ count: list.length, hotspots: list }, "hotspots", list, { max_tokens, cursor })
      );
    }
  );

  tool(
    "find_dead_code",
    "Find methods/constructors with no incoming calls, dispatch, or advice edges. Excludes framework-invoked entry points (routes, listeners, schedulers, event handlers, `main`) and test sources by default; code invoked purely through reflection may still be reported.",
    {
      limit: z.number().int().min(1).max(500).optional().describe("Max symbols returned."),
      include_constructors: z
        .boolean()
        .optional()
        .describe("Include constructors (default false)."),
      include_tests: z.boolean().optional().describe("Include test sources (default false)."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Treat dynamic-dispatch edges as callers (default true)."),
      ...budgetParams,
    },
    async ({ limit, include_constructors, include_tests, include_dynamic, max_tokens, cursor }) => {
      const results = deadCode(store, {
        limit,
        includeConstructors: include_constructors,
        includeTests: include_tests,
        includeDynamic: include_dynamic,
      });
      const unused = results.map((d) => ({ symbol: ref(d.symbol), reason: d.reason }));
      return text(
        paged({ count: unused.length, unused }, "unused", unused, { max_tokens, cursor })
      );
    }
  );

  tool(
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

  tool(
    "find_entry_points",
    "List framework-invoked roots (HTTP routes/controllers, message listeners, schedulers, event handlers, CLI entry points, tests). Root set for a runtime trace: nothing in source needs to call these.",
    {
      kind: z
        .string()
        .optional()
        .describe(
          "Filter by entry-point kind: http, messaging, scheduler, event, cli, test, route."
        ),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50)."),
      ...budgetParams,
    },
    async ({ kind, limit, max_tokens, cursor }) => {
      const results = findEntryPoints(store, { kind, limit });
      const entryPoints = results.map((e) => ({
        symbol: ref(e.symbol),
        entryPointKind: e.entryPointKind,
        ...(e.detail ? { detail: e.detail } : {}),
      }));
      return text(
        paged({ count: entryPoints.length, entryPoints }, "entryPoints", entryPoints, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "find_injections",
    "Find dependencies supplied by a DI container or framework rather than by an explicit `new`/import — Spring `@Autowired`, NestJS constructor injection, FastAPI `Depends`, and similar. Each result carries the injecting symbol, the injected type, and the framework.",
    {
      symbol: z
        .string()
        .optional()
        .describe("Restrict to a single injecting or injected symbol id/qualified name."),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50)."),
      ...budgetParams,
    },
    async ({ symbol, limit, max_tokens, cursor }) => {
      const results = findInjections(store, { symbol, limit });
      const injections = results.map((e) => ({
        source: ref(e.source),
        target: ref(e.target),
        ...(e.injectedName ? { injectedName: e.injectedName } : {}),
        ...(e.framework ? { framework: e.framework } : {}),
        ...(e.line !== undefined ? { line: line(e.line) } : {}),
        ...(e.external ? { external: true } : {}),
      }));
      return text(
        paged({ count: injections.length, injections }, "injections", injections, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "find_reflections",
    "Find run-time indirection the static call graph cannot see through: Java reflection and `ServiceLoader`, Python `getattr`/`importlib`, JavaScript `require`/dynamic `import()`. The target is the resolved symbol when it could be determined statically.",
    {
      symbol: z
        .string()
        .optional()
        .describe("Restrict to a single looking-up or looked-up symbol id/qualified name."),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50)."),
      ...budgetParams,
    },
    async ({ symbol, limit, max_tokens, cursor }) => {
      const results = findReflections(store, { symbol, limit });
      const reflections = results.map((e) => ({
        source: ref(e.source),
        target: ref(e.target),
        ...(e.mechanism ? { mechanism: e.mechanism } : {}),
        ...(e.line !== undefined ? { line: line(e.line) } : {}),
      }));
      return text(
        paged({ count: reflections.length, reflections }, "reflections", reflections, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "find_routes",
    "Map HTTP route registrations (`app.get`, `@GetMapping`, FastAPI decorators, Express routers) to the handler they invoke. Bridges framework configuration to source symbols.",
    {
      symbol: z
        .string()
        .optional()
        .describe("Restrict to a single registering or handling symbol id/qualified name."),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 50)."),
      ...budgetParams,
    },
    async ({ symbol, limit, max_tokens, cursor }) => {
      const results = findRoutes(store, { symbol, limit });
      const routes = results.map((e) => ({
        source: ref(e.source),
        handler: ref(e.target),
        ...(e.httpMethod ? { httpMethod: e.httpMethod } : {}),
        ...(e.path ? { path: e.path } : {}),
        ...(e.framework ? { framework: e.framework } : {}),
        ...(e.line !== undefined ? { line: line(e.line) } : {}),
      }));
      return text(
        paged({ count: routes.length, routes }, "routes", routes, { max_tokens, cursor })
      );
    }
  );

  tool(
    "find_external_dependencies",
    "Summarize third-party packages the crawled source imports, with reference and file counts. External libraries are modelled as package-level nodes: the crawler records the dependency, not the library's internals.",
    {
      limit: z.number().int().min(1).max(500).optional().describe("Max packages (default 50)."),
      ...budgetParams,
    },
    async ({ limit, max_tokens, cursor }) => {
      const results = externalDependencies(store, { limit });
      const packages = results.map((p) => ({
        package: p.package,
        references: p.references,
        files: p.files,
        kinds: p.kinds,
      }));
      return text(
        paged({ count: packages.length, packages }, "packages", packages, {
          max_tokens,
          cursor,
        })
      );
    }
  );

  tool(
    "get_schema",
    "Describe the property-graph model: node kinds, edge kinds, and the id scheme (including annotations, aspects, and dynamic edges).",
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
          annotation: "@Transactional",
          module: "module:app/services/orders",
          external: "ext:requests",
          import: "__import__:com.acme.Foo",
          unknown: "__unknown__:System.out.println",
        },
        languages: ["java", "python", "typescript", "javascript"],
        entryPoints:
          "Nodes carry `entryPoint: 1`, `entryPointKind`, and `entryPointDetail` when a framework or runtime invokes them without a source-level call (HTTP routes, message listeners, schedulers, event handlers, CLI mains, tests).",
        dynamicModel: {
          DYNAMIC_DISPATCH:
            "caller -> concrete override/implementation; inferred from the type hierarchy and virtual/interface dispatch.",
          ADVISES:
            "advice method -> advised method; matched from @Before/@After/@Around pointcuts.",
          INJECTS:
            "injecting symbol -> injected type; DI/framework wiring such as @Autowired, NestJS constructor params, FastAPI Depends.",
          REFLECTS:
            "looking-up symbol -> resolved target; Class.forName, ServiceLoader, getattr, importlib, require, dynamic import().",
          ROUTES:
            "registering symbol -> handler symbol; HTTP route/verb/path recorded on the edge.",
          ANNOTATED_WITH: "symbol -> annotation/decorator node; carries arguments and source line.",
          CARRIES_CONTROL_FLOW:
            "CALLS edges carry `conditional` and `controlFlow` (branch/loop/exception/predicate) plus the enclosing guard text.",
        },
        lineNumbers: "1-based in tool output",
      });
    }
  );

  tool(
    "clear_index",
    "Wipe the entire graph database. Use with caution — you must crawl_project again afterwards.",
    {},
    async () => {
      store.clearAll();
      return text({ ok: true, cleared: true });
    }
  );

  tool(
    "find_unresolved",
    "List call sites the resolver could not bind to a symbol, grouped by reason, with the caller, source line and the callee text as written. This is the honest boundary of static analysis: dynamic receivers, untyped values, missing dependencies. Use it to judge how much of a project the index actually covers, and as the highest-signal input for improving a parser.",
    {
      reason: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the resolver failure reason."),
      caller_kind: z
        .enum(NODE_KINDS)
        .optional()
        .describe("Restrict to unresolved calls made by callers of this node kind."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Max call sites scanned (default 2000)."),
      ...budgetParams,
    },
    async ({ reason, caller_kind, limit, max_tokens, cursor }) => {
      const report = findUnresolved(store, { reason, kind: caller_kind, limit });
      const calls = report.calls.map((c) => ({
        caller: ref(c.caller),
        target: c.targetLabel,
        reason: c.reason,
        line: line(c.line),
      }));
      return text(
        paged(
          {
            count: calls.length,
            total: report.total,
            scanTruncated: report.scanTruncated,
            byReason: report.byReason,
            unresolved: calls,
          },
          "unresolved",
          calls,
          { max_tokens, cursor }
        )
      );
    }
  );

  tool(
    "impact_analysis",
    "One call that answers 'what breaks if I change this?': reverse callers to a depth, framework entry points that reach the symbol, HTTP routes that serve it, and overriding implementations. Analysing a type aggregates the callers of all its methods. Returns a heuristic risk band: high when a framework entry point reaches the symbol, medium when it has direct callers, low otherwise.",
    {
      symbol: z.string().describe("Symbol id or qualified name."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Caller traversal depth (default 10)."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Also follow DYNAMIC_DISPATCH edges (default true)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Max callers returned (default 200)."),
    },
    async ({ symbol, max_depth, include_dynamic, limit }) => {
      const result = impactAnalysis(store, symbol, {
        maxDepth: max_depth,
        includeDynamic: include_dynamic,
        limit,
      });
      if (!result) return notFound(symbol);
      return text({
        symbol: ref(result.symbol),
        summary: result.summary,
        callers: result.callers.map((c) => ({
          caller: ref(c.caller),
          depth: c.depth,
          callSiteLine: line(c.callSiteLine),
          edgeKind: c.edgeKind,
        })),
        entryPoints: result.entryPoints.map((e) => ({
          symbol: ref(e.symbol),
          entryPointKind: e.entryPointKind,
          ...(e.detail ? { detail: e.detail } : {}),
          viaDepth: e.viaDepth,
        })),
        routes: result.routes.map(wiring),
        implementations: result.implementations.map((i) => ({
          type: ref(i.type),
          ...(i.method ? { method: ref(i.method) } : {}),
          depth: i.depth,
          via: i.via,
        })),
        affectedFiles: result.affectedFiles,
      });
    }
  );

  tool(
    "explain_symbol",
    "One-shot digest of a symbol: kind, file and line, annotations/decorators, contained members with their decorators, direct callers and callees, overriding implementations, and the framework wiring that reaches it (routes, injections, reflections). Replaces a chain of five lookups with one round trip.",
    {
      symbol: z.string().describe("Symbol id or qualified name."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Caller/callee traversal depth (default 1)."),
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Also follow DYNAMIC_DISPATCH edges (default true)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max rows per section (default 50)."),
    },
    async ({ symbol, max_depth, include_dynamic, limit }) => {
      const result = explainSymbol(store, symbol, {
        maxDepth: max_depth,
        includeDynamic: include_dynamic,
        limit,
      });
      if (!result) return notFound(symbol);
      return text({
        symbol: ref(result.symbol),
        line: line(result.line),
        isEntryPoint: result.isEntryPoint ?? false,
        decorators: result.decorators.map((d) => ({ ...d, line: line(d.line) })),
        members: result.members.map((m) => ({
          symbol: ref(m.symbol),
          line: line(m.line),
          decorators: m.decorators.map((d) => ({ ...d, line: line(d.line) })),
        })),
        callers: result.callers.map((c) => ({
          caller: ref(c.caller),
          depth: c.depth,
          callSiteLine: line(c.callSiteLine),
          edgeKind: c.edgeKind,
        })),
        callees: result.callees.map((c) => ({
          caller: ref(c.caller),
          depth: c.depth,
          callSiteLine: line(c.callSiteLine),
          edgeKind: c.edgeKind,
        })),
        implementations: result.implementations.map((i) => ({
          type: ref(i.type),
          ...(i.method ? { method: ref(i.method) } : {}),
          depth: i.depth,
          via: i.via,
        })),
        routes: result.routes.map(wiring),
        injections: result.injections.map(wiring),
        reflections: result.reflections.map(wiring),
        summary: result.summary,
      });
    }
  );

  tool(
    "find_cycles",
    "Find call cycles (strongly connected components of the call graph) with a sample closed path for each. Direct recursion is reported separately in selfRecursive. Useful for spotting layer violations, accidental mutual recursion and hard-to-test tangles. Follows CALLS edges, plus DYNAMIC_DISPATCH unless disabled.",
    {
      include_dynamic: z
        .boolean()
        .optional()
        .describe("Include DYNAMIC_DISPATCH edges (default true)."),
      min_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Minimum cycle size to report (default 2)."),
      edge_kinds: z
        .array(z.enum(EDGE_KINDS))
        .optional()
        .describe("Explicit edge kinds to follow, overriding include_dynamic."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max cycles returned (default 100)."),
      ...budgetParams,
    },
    async ({ include_dynamic, min_size, edge_kinds, limit, max_tokens, cursor }) => {
      const report = findCycles(store, {
        includeDynamic: include_dynamic ?? true,
        minSize: min_size,
        edgeKinds: edge_kinds,
        limit,
      });
      const cycles = report.cycles.map((c) => ({
        size: c.size,
        members: c.members.map(ref),
        sample: c.sample,
      }));
      return text(
        paged(
          {
            count: cycles.length,
            cycleCount: report.cycleCount,
            edgeKinds: report.edgeKinds,
            scannedNodes: report.scannedNodes,
            scannedEdges: report.scannedEdges,
            scanTruncated: report.scanTruncated,
            selfRecursive: report.selfRecursive.map(ref),
            cycles,
          },
          "cycles",
          cycles,
          { max_tokens, cursor }
        )
      );
    }
  );

  tool(
    "export_graph",
    "Render a neighborhood, or a slice of the whole graph, as a Mermaid or Graphviz DOT diagram. Use it when showing the shape of the code beats listing edges. Center the export on a symbol and keep the radius small so the diagram stays readable.",
    {
      symbol: z
        .string()
        .optional()
        .describe("Center symbol id or qualified name; omit to export a slice of the whole graph."),
      radius: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Neighborhood radius around the symbol (default 2)."),
      format: z.enum(["mermaid", "dot"]).optional().describe("Diagram format (default mermaid)."),
      direction: z
        .enum(["LR", "TB", "RL", "BT"])
        .optional()
        .describe("Layout direction (default LR)."),
      edge_kinds: z.array(z.enum(EDGE_KINDS)).optional().describe("Edge kinds to draw."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max nodes (default 200)."),
    },
    async ({ symbol, radius, format, direction, edge_kinds, limit }) => {
      const result = exportGraph(store, {
        symbol,
        radius,
        format,
        direction,
        edgeKinds: edge_kinds,
        limit,
      });
      if (!result) return notFound(symbol ?? "");
      return text(result);
    }
  );

  // ------------------------------------------------------------- resources

  server.registerResource(
    "graph-schema",
    "codecrawler://schema",
    {
      title: "Graph schema",
      description: "Node and edge kinds used by the codebase property graph.",
    },
    async () => ({
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
                annotation: "@Transactional",
                module: "module:app/services/orders",
                external: "ext:requests",
                import: "__import__:com.acme.Foo",
                unknown: "__unknown__:System.out.println",
              },
              languages: ["java", "python", "typescript", "javascript"],
              dynamicModel: {
                DYNAMIC_DISPATCH:
                  "caller -> concrete override/implementation, inferred from the type hierarchy.",
                ADVISES: "advice method -> advised method, matched from AspectJ pointcuts.",
                INJECTS: "injecting symbol -> injected type, from DI/framework wiring.",
                REFLECTS: "looking-up symbol -> resolved target, from reflection/dynamic import.",
                ROUTES: "registering symbol -> handler symbol, with HTTP verb and path.",
                ANNOTATED_WITH: "symbol -> annotation node, carrying arguments and source line.",
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerResource(
    "index-status",
    "codecrawler://status",
    {
      title: "Index status",
      description: "Current index summary (nodes, edges, files, last crawl).",
    },
    async () => {
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
    }
  );

  // --------------------------------------------------------------- prompts

  server.prompt(
    "trace-call-path",
    "Given two symbols, trace every static call path between them.",
    {
      from: z.string().describe("Starting symbol"),
      to: z.string().describe("Destination symbol"),
    },
    async ({ from, to }) => {
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
                paths.map((p, i) => `${i + 1}. ${p.path.join(" -> ")}`).join("\n") +
                `\n\nUse \`get_callers\` or \`get_callees\` on intermediate symbols to explore further.`,
            },
          },
        ],
      };
    }
  );

  return server;
}

export { loadConfig };
