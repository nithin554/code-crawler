import type { EdgeKind, GraphNode, NodeKind } from "./schema.js";
import { annotationNodeId } from "./schema.js";
import type { GraphStore } from "./store.js";

/**
 * Traversal queries over the property graph.
 *
 * All queries operate on CALLS edges (directed: caller -> callee) plus
 * arbitrary edge kinds where relevant. Depth-bounded recursive CTEs keep
 * queries bounded even on large graphs.
 */

export interface SymbolRef {
  id: string;
  qualifiedName: string;
  name?: string;
  kind: NodeKind;
  filePath: string | null;
  line?: number;
}

export interface CallerInfo {
  caller: SymbolRef;
  /** Properties of the call edge (call site line, resolution, confidence). */
  callSiteLine?: number;
  resolved?: boolean;
  /** Which edge kind connected the caller: CALLS | DYNAMIC_DISPATCH | ADVISES. */
  edgeKind?: EdgeKind;
}

/** Syntactic control-flow context recorded on a call/route edge. */
export interface FlowEdgeInfo {
  /** True when the call only runs inside a branch, loop or handler. */
  conditional?: boolean;
  /** Enclosing control-flow categories: branch, loop, exception, predicate. */
  controlFlow?: string[];
  /** Compact source text of the enclosing conditions. */
  guards?: string[];
}

export function nodeToRef(node: GraphNode): SymbolRef {
  return {
    id: node.id,
    qualifiedName: node.qualifiedName,
    name: node.properties.name,
    kind: node.kind,
    filePath: node.filePath,
  };
}

/** Resolve a node by exact id or by qualified name, favoring id. */
export function resolveNode(store: GraphStore, symbol: string): GraphNode | null {
  return store.getNode(symbol) ?? store.getNodeByQualifiedName(symbol);
}

/** Options controlling which dynamic edges a traversal follows. */
export interface DynamicEdgeOptions {
  /** Follow DYNAMIC_DISPATCH edges (virtual/interface call targets). */
  includeDynamic?: boolean;
  /** Follow ADVISES edges (aspect advice -> advised method). */
  includeAdvice?: boolean;
}

/** Edge kinds a traversal should follow, ordered from most to least certain. */
export function traversalEdgeKinds(opts: DynamicEdgeOptions = {}): EdgeKind[] {
  const kinds: EdgeKind[] = ["CALLS"];
  if (opts.includeDynamic) kinds.push("DYNAMIC_DISPATCH");
  if (opts.includeAdvice) kinds.push("ADVISES");
  return kinds;
}

export function sqlKinds(kinds: EdgeKind[]): string {
  return kinds.map((k) => `'${k}'`).join(",");
}

export interface CallerQueryOptions extends DynamicEdgeOptions {
  /** Include transitive callers (whole call graph above). Default true. */
  transitive?: boolean;
  /** Max depth for transitive traversal. Bounded by config maxDepth. */
  maxDepth?: number;
  /** Cap total rows returned. */
  limit?: number;
}

/**
 * Find every symbol that calls the given symbol, directly or transitively.
 * Each row includes the edge chain depth so clients can render a call tree.
 */
export function getCallers(
  store: GraphStore,
  symbol: string,
  opts: CallerQueryOptions = {}
): {
  target: SymbolRef;
  callers: ({
    caller: SymbolRef;
    depth: number;
    callSiteLine?: number;
    edgeKind: EdgeKind;
  } & FlowEdgeInfo)[];
} | null {
  const target = resolveNode(store, symbol);
  if (!target) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;
  const kinds = traversalEdgeKinds(opts);

  if (!transitive) {
    const rows = store.raw<RowWithEdge & { edge_kind: EdgeKind }>(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
              e.properties AS edge_props, e.kind AS edge_kind
       FROM edges e
       JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind IN (${sqlKinds(kinds)})
       ORDER BY e.kind, e.source
       LIMIT ?`,
      target.id,
      limit
    );
    return {
      target: nodeToRef(target),
      callers: rows.map((r) => ({
        caller: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
        edgeKind: r.edge_kind,
        ...edgeFlow(r.edge_props),
      })),
    };
  }

  const rows = store.raw<RowWithEdge & { depth: number; edge_kind: EdgeKind }>(
    `WITH RECURSIVE callers(id, depth, edge_kind, edge_props) AS (
       SELECT e.source, 1, e.kind, e.properties
       FROM edges e
       WHERE e.target = ? AND e.kind IN (${sqlKinds(kinds)})
       UNION
       SELECT e.source, c.depth + 1, e.kind, e.properties
       FROM edges e
       JOIN callers c ON e.target = c.id
       WHERE e.kind IN (${sqlKinds(kinds)})
         AND c.depth < ?
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            MIN(c.depth) AS depth, c.edge_kind, c.edge_props
     FROM callers c
     JOIN nodes n ON n.id = c.id
     WHERE c.id <> ?
     GROUP BY c.id
     ORDER BY depth, n.id
     LIMIT ?`,
    target.id,
    maxDepth,
    target.id,
    limit
  );

  return {
    target: nodeToRef(target),
    callers: rows.map((r) => ({
      caller: rowToRef(r),
      depth: r.depth,
      callSiteLine: edgeLine(r.edge_props),
      edgeKind: r.edge_kind,
      ...edgeFlow(r.edge_props),
    })),
  };
}

export interface CalleeQueryOptions extends DynamicEdgeOptions {
  /** Include transitive callees (whole call graph below). Default true. */
  transitive?: boolean;
  maxDepth?: number;
  limit?: number;
}

/**
 * Find every symbol the given symbol calls, directly or transitively.
 */
export function getCallees(
  store: GraphStore,
  symbol: string,
  opts: CalleeQueryOptions = {}
): {
  source: SymbolRef;
  callees: ({
    callee: SymbolRef;
    depth: number;
    callSiteLine?: number;
    edgeKind: EdgeKind;
  } & FlowEdgeInfo)[];
} | null {
  const source = resolveNode(store, symbol);
  if (!source) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;
  const kinds = traversalEdgeKinds(opts);

  if (!transitive) {
    const rows = store.raw<RowWithEdge & { edge_kind: EdgeKind }>(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
              e.properties AS edge_props, e.kind AS edge_kind
       FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind IN (${sqlKinds(kinds)})
       ORDER BY e.kind, e.target
       LIMIT ?`,
      source.id,
      limit
    );
    return {
      source: nodeToRef(source),
      callees: rows.map((r) => ({
        callee: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
        edgeKind: r.edge_kind,
        ...edgeFlow(r.edge_props),
      })),
    };
  }

  const rows = store.raw<RowWithEdge & { depth: number; edge_kind: EdgeKind }>(
    `WITH RECURSIVE callees(id, depth, edge_kind, edge_props) AS (
       SELECT e.target, 1, e.kind, e.properties
       FROM edges e
       WHERE e.source = ? AND e.kind IN (${sqlKinds(kinds)})
       UNION
       SELECT e.target, c.depth + 1, e.kind, e.properties
       FROM edges e
       JOIN callees c ON e.source = c.id
       WHERE e.kind IN (${sqlKinds(kinds)})
         AND c.depth < ?
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            MIN(c.depth) AS depth, c.edge_kind, c.edge_props
     FROM callees c
     JOIN nodes n ON n.id = c.id
     WHERE c.id <> ?
     GROUP BY c.id
     ORDER BY depth, n.id
     LIMIT ?`,
    source.id,
    maxDepth,
    source.id,
    limit
  );

  return {
    source: nodeToRef(source),
    callees: rows.map((r) => ({
      callee: rowToRef(r),
      depth: r.depth,
      callSiteLine: edgeLine(r.edge_props),
      edgeKind: r.edge_kind,
      ...edgeFlow(r.edge_props),
    })),
  };
}

export interface PathEntry {
  /** Ordered list of symbol ids from source to target (inclusive). */
  path: string[];
  length: number;
  edges: {
    source: string;
    target: string;
    kind?: EdgeKind;
    callSiteLine?: number;
    resolved?: boolean;
  }[];
}

export interface TracePathOptions extends DynamicEdgeOptions {
  maxDepth?: number;
  limit?: number;
}

/**
 * Find up to `limit` call paths between two symbols.
 * BFS over the selected edge kinds so the shortest paths come first.
 */
export function tracePath(
  store: GraphStore,
  from: string,
  to: string,
  opts: TracePathOptions = {}
): PathEntry[] | null {
  const start = resolveNode(store, from);
  const goal = resolveNode(store, to);
  if (!start || !goal) return null;

  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 10;
  const kinds = sqlKinds(traversalEdgeKinds(opts));

  // BFS in SQL via recursive CTE that accumulates the path taken.
  const rows = store.raw<{ path: string; edge_path: string; depth: number }>(
    `WITH RECURSIVE paths(id, depth, path, edge_path) AS (
       SELECT e.target, 1, e.source || '/' || e.target,
              e.source || '>' || e.target || '>' || e.kind
       FROM edges e
       WHERE e.source = ? AND e.kind IN (${kinds})
       UNION ALL
       SELECT e.target, p.depth + 1, p.path || '/' || e.target,
              p.edge_path || '|' || e.source || '>' || e.target || '>' || e.kind
       FROM edges e
       JOIN paths p ON e.source = p.id
       WHERE e.kind IN (${kinds})
         AND p.depth < ?
         AND instr('|' || p.path || '|', '|' || e.target || '|') = 0
     )
     SELECT path, edge_path, depth
     FROM paths
     WHERE id = ?
     ORDER BY depth
     LIMIT ?`,
    start.id,
    maxDepth,
    goal.id,
    limit
  );

  return rows.map((r) => {
    const ids = r.path.split("/");
    const edges = r.edge_path.split("|").map((triple) => {
      const [src, tgt, kind, ...rest] = triple.split(">");
      // Method ids may contain '>'? No, node ids use type#method and $field.
      void rest;
      const edge = {
        source: src ?? "",
        target: tgt ?? "",
        kind: (kind as EdgeKind | undefined) ?? undefined,
        callSiteLine: undefined as number | undefined,
        resolved: undefined as boolean | undefined,
      };
      const props = store.raw<{ properties: string }>(
        "SELECT properties FROM edges WHERE source = ? AND target = ? AND kind = ? LIMIT 1",
        edge.source,
        edge.target,
        edge.kind
      );
      const parsed = props[0]
        ? (JSON.parse(props[0].properties) as { line?: number; resolved?: boolean })
        : undefined;
      edge.callSiteLine = parsed?.line;
      edge.resolved = parsed?.resolved;
      return edge;
    });
    return { path: ids, length: r.depth, edges };
  });
}

export interface ExecutionTraceOptions extends DynamicEdgeOptions {
  maxDepth?: number;
  limit?: number;
}

export interface ExecutionStep {
  symbol: SymbolRef;
  depth: number;
  /** How the runtime reached this symbol. INTERCEPT marks woven advice. */
  via?: EdgeKind | "INTERCEPT";
  callSiteLine?: number;
}

/**
 * Dynamic execution trace: follows static + virtual dispatch edges and weaves
 * in aspect advice. When a call reaches an advised method, the advice method
 * is visited first (an `INTERCEPT` edge), then the method itself.
 */
export function traceExecution(
  store: GraphStore,
  symbol: string,
  opts: ExecutionTraceOptions = {}
): { root: SymbolRef; steps: ExecutionStep[] } | null {
  const root = resolveNode(store, symbol);
  if (!root) return null;

  const includeDynamic = opts.includeDynamic ?? true;
  const includeAdvice = opts.includeAdvice ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 200;

  const baseKinds: EdgeKind[] = ["CALLS"];
  if (includeDynamic) baseKinds.push("DYNAMIC_DISPATCH");
  const base = sqlKinds(baseKinds);
  // Advice intercepts an advised method, so the woven hop runs
  // advised-method -> advice-method. ADVISES itself is a relation, not a call,
  // and must not be traversed as an ordinary edge.
  const interceptJoin = includeAdvice
    ? `UNION ALL
       SELECT a.target, a.source, 'INTERCEPT', a.properties, 0
       FROM edges a
       WHERE a.kind = 'ADVISES'`
    : "";

  const rows = store.raw<
    RowWithEdge & { depth: number; via: EdgeKind | "INTERCEPT" | null; step_props: string | null }
  >(
    `WITH RECURSIVE flow(source, target, kind, properties, advice_hop) AS (
       SELECT source, target, kind, properties, 0 FROM edges WHERE kind IN (${base})
       ${interceptJoin}
     ),
     walk(id, depth, path, parent, via, properties) AS (
       SELECT ?, 0, ?, NULL, NULL, NULL
       UNION ALL
       SELECT f.target, w.depth + 1, w.path || '/' || f.target, w.id, f.kind, f.properties
       FROM flow f
       JOIN walk w ON f.source = w.id
       WHERE w.depth < ?
         AND instr('|' || w.path || '|', '|' || f.target || '|') = 0
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            w.depth, w.via, w.properties AS step_props
     FROM walk w
     JOIN nodes n ON n.id = w.id
     WHERE w.depth > 0
     ORDER BY w.depth, n.id
     LIMIT ?`,
    root.id,
    root.id,
    maxDepth,
    limit
  );

  // Multiple runtime paths can reach the same symbol; report it once at the
  // shallowest depth so the trace reads as execution order, not all paths.
  const seen = new Set<string>();
  const steps: ExecutionStep[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    steps.push({
      symbol: rowToRef(r),
      depth: r.depth,
      via: r.via ?? undefined,
      callSiteLine: edgeLine(r.step_props ?? undefined),
    });
  }

  return { root: nodeToRef(root), steps };
}

export interface SubgraphOptions {
  radius?: number;
  edgeKinds?: EdgeKind[];
  limit?: number;
}

export interface SubgraphResult {
  center: SymbolRef | null;
  nodes: SymbolRef[];
  edges: { source: string; target: string; kind: EdgeKind; callSiteLine?: number }[];
}

/**
 * Extract the neighborhood around a symbol (any edge kinds), useful for
 * visualization and for letting an LLM see the local shape of the graph.
 */
export function getSubgraph(
  store: GraphStore,
  symbol: string,
  opts: SubgraphOptions = {}
): SubgraphResult {
  const center = resolveNode(store, symbol);
  if (!center) return { center: null, nodes: [], edges: [] };

  const radius = Math.max(1, opts.radius ?? 2);
  const edgeKinds = opts.edgeKinds ?? [
    "CALLS",
    "DYNAMIC_DISPATCH",
    "ADVISES",
    "DECLARED_IN",
    "CONTAINS",
    "EXTENDS",
    "IMPLEMENTS",
    "ANNOTATED_WITH",
    "REFERENCES",
    "IMPORTS",
    "REFLECTS",
    "INJECTS",
    "ROUTES",
  ];
  const limit = opts.limit ?? 500;

  const kinds = edgeKinds.map((k) => `'${k}'`).join(",");
  const rows = store.raw<Row>(
    `WITH RECURSIVE reach(id, depth) AS (
       SELECT ? , 0
       UNION
       SELECT e.target, r.depth + 1
       FROM edges e
       JOIN reach r ON e.source = r.id
       WHERE e.kind IN (${kinds}) AND r.depth < ?
       UNION
       SELECT e.source, r.depth + 1
       FROM edges e
       JOIN reach r ON e.target = r.id
       WHERE e.kind IN (${kinds}) AND r.depth < ?
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, r.depth
     FROM reach r
     JOIN nodes n ON n.id = r.id
     ORDER BY r.depth, n.id
     LIMIT ?`,
    center.id,
    radius,
    radius,
    limit
  );

  const nodes = rows.map(rowToRef);
  const ids = nodes.map((n) => n.id);
  if (ids.length === 0) return { center: nodeToRef(center), nodes, edges: [] };

  const placeholders = ids.map(() => "?").join(",");
  const edgeRows = store.raw<{
    source: string;
    target: string;
    kind: EdgeKind;
    properties: string;
  }>(
    `SELECT source, target, kind, properties
     FROM edges
     WHERE kind IN (${kinds})
       AND source IN (${placeholders}) AND target IN (${placeholders})
     LIMIT ?`,
    ...ids,
    ...ids,
    limit
  );

  return {
    center: nodeToRef(center),
    nodes,
    edges: edgeRows.map((r) => ({
      source: r.source,
      target: r.target,
      kind: r.kind,
      callSiteLine: edgeLine(r.properties),
    })),
  };
}

export interface SearchOptions {
  kind?: NodeKind | null;
  limit?: number;
}

/**
 * Fuzzy symbol lookup by short name or FQN. Matches the id or qualified name
 * only; metadata properties are never treated as symbol names.
 *
 * The FTS5 index answers the common case (token prefixes such as `place` or
 * `com.acme.Ord`) in one index lookup, and the older substring scan is kept as
 * a fallback so queries that start mid-token (`lace`) still work. Ranking
 * happens in SQL before LIMIT, so good matches cannot be truncated away: exact
 * qualified name, exact id, exact display name, then prefixes, then the rest.
 */
export function searchSymbols(
  store: GraphStore,
  query: string,
  opts: SearchOptions = {}
): SymbolRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? store.defaultLimit ?? 50;

  const match = ftsPrefixQuery(q);
  if (match) {
    const rows = store.raw<Row>(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
       FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH ?
       ${opts.kind ? "AND n.kind = ?" : ""}
       ORDER BY
         CASE
           WHEN LOWER(n.qualified_name) = ? THEN 0
           WHEN LOWER(n.id) = ? THEN 1
           WHEN LOWER(n.name) = ? THEN 2
           WHEN LOWER(n.qualified_name) LIKE ? THEN 3
           WHEN LOWER(n.id) LIKE ? THEN 4
           ELSE 5
         END,
         bm25(nodes_fts),
         LENGTH(n.qualified_name),
         n.qualified_name,
         n.id
       LIMIT ?`,
      ...(opts.kind
        ? [match, opts.kind, q, q, q, `${q}%`, `${q}%`, limit]
        : [match, q, q, q, `${q}%`, `${q}%`, limit])
    );
    if (rows.length > 0) return rows.map((r) => rowToRef(r));
  }

  return searchBySubstring(store, q, opts.kind, limit);
}

/** Turn a free-text query into an FTS5 prefix expression, e.g. `"com"* AND "ord"*`. */
function ftsPrefixQuery(q: string): string | null {
  const tokens = q
    .split(/[^a-z0-9_]+/)
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" AND ");
}

/** Substring scan used when no FTS token matches. */
function searchBySubstring(
  store: GraphStore,
  q: string,
  kind: NodeKind | null | undefined,
  limit: number
): SymbolRef[] {
  const like = `%${q}%`;
  const prefix = `${q}%`;

  const kindClause = kind ? "AND n.kind = ?" : "";
  const params: unknown[] = [like, like];
  if (kind) params.push(kind);
  params.push(q, q, q, prefix, prefix, limit);

  const rows = store.raw<Row>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE (LOWER(n.id) LIKE ? OR LOWER(n.qualified_name) LIKE ?)
     ${kindClause}
     ORDER BY
       CASE
         WHEN LOWER(n.qualified_name) = ? THEN 0
         WHEN LOWER(n.id) = ? THEN 1
         WHEN json_valid(n.properties)
           AND LOWER(json_extract(n.properties, '$.name')) = ? THEN 2
         WHEN LOWER(n.qualified_name) LIKE ? THEN 3
         WHEN LOWER(n.id) LIKE ? THEN 4
         ELSE 5
       END,
       LENGTH(n.qualified_name),
       n.qualified_name,
       n.id
     LIMIT ?`,
    ...params
  );

  return rows.map((r) => rowToRef(r));
}

/** Suggest similar symbols when an exact lookup fails. */
export function suggestSymbols(store: GraphStore, symbol: string, limit = 8): SymbolRef[] {
  const tokens = symbol
    .split(/[.#$<>]/)
    .filter((t) => t.length > 1)
    .slice(-1);
  const best = tokens[0] ?? symbol.slice(-20);
  return searchSymbols(store, best, { limit });
}

export interface ImplementationResult {
  target: SymbolRef;
  implementations: {
    type: SymbolRef;
    depth: number;
    via: "EXTENDS" | "IMPLEMENTS";
  }[];
}

/**
 * Find every type that implements/extends a given interface or superclass,
 * directly or transitively.
 */
export function findImplementations(
  store: GraphStore,
  symbol: string,
  opts: { maxDepth?: number; limit?: number } = {}
): ImplementationResult | null {
  const target = resolveNode(store, symbol);
  if (!target) return null;

  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;

  const rows = store.raw<Row & { depth: number; via: "EXTENDS" | "IMPLEMENTS" }>(
    `WITH RECURSIVE impl(id, depth, via) AS (
       SELECT e.source, 1, e.kind
       FROM edges e
       WHERE e.target = ? AND e.kind IN ('EXTENDS', 'IMPLEMENTS')
       UNION
       SELECT e.source, i.depth + 1, e.kind
       FROM edges e
       JOIN impl i ON e.target = i.id
       WHERE e.kind IN ('EXTENDS', 'IMPLEMENTS')
         AND i.depth < ?
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            MIN(i.depth) AS depth, i.via
     FROM impl i
     JOIN nodes n ON n.id = i.id
     WHERE n.kind IN ('class', 'interface', 'enum', 'aspect', 'annotation_type')
       AND i.id <> ?
     GROUP BY i.id
     ORDER BY depth, n.qualified_name
     LIMIT ?`,
    target.id,
    maxDepth,
    target.id,
    limit
  );

  return {
    target: nodeToRef(target),
    implementations: rows.map((r) => ({
      type: rowToRef(r),
      depth: r.depth,
      via: r.via,
    })),
  };
}

export interface AdviceDetail {
  method: SymbolRef;
  adviceKind?: string;
  pointcut?: string;
  advised: SymbolRef[];
}

export interface AspectDetail {
  aspect: SymbolRef;
  advice: AdviceDetail[];
}

/** List aspects, their advice methods, and the methods each advice intercepts. */
export function getAspects(store: GraphStore, opts: { limit?: number } = {}): AspectDetail[] {
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const aspectRows = store.raw<Row>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE n.kind = 'aspect'
     ORDER BY n.qualified_name
     LIMIT ?`,
    limit
  );

  return aspectRows.map((row) => {
    const aspect = rowToRef(row);
    const members = store.raw<Row>(
      `SELECT m.id, m.qualified_name, m.kind, m.file_path, m.properties
       FROM edges e
       JOIN nodes m ON m.id = e.target
       WHERE e.source = ? AND e.kind = 'CONTAINS'
         AND m.kind = 'method'
       ORDER BY m.qualified_name`,
      aspect.id
    );

    const advice: AdviceDetail[] = [];
    for (const member of members) {
      const props = JSON.parse(member.properties) as {
        adviceKind?: string;
        pointcut?: string;
      };
      const advisedRows = store.raw<Row>(
        `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
         FROM edges e
         JOIN nodes n ON n.id = e.target
         WHERE e.source = ? AND e.kind = 'ADVISES'
         ORDER BY n.qualified_name`,
        member.id
      );
      if (!props.adviceKind && advisedRows.length === 0) continue;
      advice.push({
        method: rowToRef(member),
        adviceKind: props.adviceKind,
        pointcut: props.pointcut,
        advised: advisedRows.map(rowToRef),
      });
    }

    return { aspect, advice };
  });
}

export interface DecoratorInfo {
  name: string;
  fqn?: string;
  decorator: boolean;
  line?: number;
  arguments: string[];
}

export interface SymbolDecorators {
  symbol: SymbolRef;
  decorators: DecoratorInfo[];
  members: { symbol: SymbolRef; decorators: DecoratorInfo[] }[];
}

function decoratorsFor(store: GraphStore, ids: string[]): DecoratorInfo[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = store.raw<{ qualified_name: string; ann_props: string; edge_props: string }>(
    `SELECT a.qualified_name, a.properties AS ann_props, e.properties AS edge_props
     FROM edges e
     JOIN nodes a ON a.id = e.target
     WHERE e.kind = 'ANNOTATED_WITH' AND e.source IN (${placeholders})
     ORDER BY a.qualified_name`,
    ...ids
  );

  return rows.map((r) => {
    const ann = JSON.parse(r.ann_props) as {
      name?: string;
      fqn?: string;
      decorator?: boolean;
    };
    const edge = JSON.parse(r.edge_props) as { line?: number; arguments?: string[] };
    return {
      name: ann.name ?? r.qualified_name,
      fqn: ann.fqn,
      decorator: ann.decorator ?? false,
      line: edge.line,
      arguments: edge.arguments ?? [],
    };
  });
}

/**
 * Decorators/annotations applied to a symbol, optionally including the
 * annotations on its declared members (methods, constructors, fields).
 */
export function getDecorators(
  store: GraphStore,
  symbol: string,
  opts: { includeMembers?: boolean } = {}
): SymbolDecorators | null {
  const node = resolveNode(store, symbol);
  if (!node) return null;

  const decorators = decoratorsFor(store, [node.id]);
  if (!opts.includeMembers) return { symbol: nodeToRef(node), decorators, members: [] };

  const memberRows = store.raw<Row>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM edges e
     JOIN nodes n ON n.id = e.target
     WHERE e.source = ? AND e.kind = 'CONTAINS'
       AND n.kind IN ('method', 'constructor', 'field')
     ORDER BY n.qualified_name`,
    node.id
  );

  return {
    symbol: nodeToRef(node),
    decorators,
    members: memberRows
      .map((row) => {
        const ref = rowToRef(row);
        return { symbol: ref, decorators: decoratorsFor(store, [ref.id]) };
      })
      .filter((m) => m.decorators.length > 0),
  };
}

export interface AnnotatedSymbol {
  symbol: SymbolRef;
  annotation: { name: string; fqn?: string };
  line?: number;
  arguments: string[];
}

/**
 * Find every symbol annotated/decorated with the given annotation. Accepts a
 * simple name (`Transactional`), a node id (`@Transactional`) or an FQN.
 */
export function findAnnotated(
  store: GraphStore,
  annotation: string,
  opts: { kind?: NodeKind; limit?: number } = {}
): AnnotatedSymbol[] {
  const trimmed = annotation.trim();
  if (!trimmed) return [];
  const name = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const kindClause = opts.kind ? "AND n.kind = ?" : "";

  const params: unknown[] = [annotationNodeId(name), name, `%.${name}`, `%"name":"${name}"%`];
  if (opts.kind) params.push(opts.kind);
  params.push(limit);

  const rows = store.raw<Row & { ann_props: string; edge_props: string }>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            a.properties AS ann_props, e.properties AS edge_props
     FROM edges e
     JOIN nodes n ON n.id = e.source
     JOIN nodes a ON a.id = e.target
     WHERE e.kind = 'ANNOTATED_WITH'
       AND (a.id = ? OR a.qualified_name = ? OR a.qualified_name LIKE ? OR LOWER(a.properties) LIKE LOWER(?))
       ${kindClause}
     ORDER BY n.qualified_name
     LIMIT ?`,
    ...params
  );

  return rows.map((r) => {
    const ann = JSON.parse(r.ann_props) as { name?: string; fqn?: string };
    const edge = JSON.parse(r.edge_props) as { line?: number; arguments?: string[] };
    return {
      symbol: rowToRef(r),
      annotation: { name: ann.name ?? name, fqn: ann.fqn },
      line: edge.line,
      arguments: edge.arguments ?? [],
    };
  });
}

export interface Hotspot {
  symbol: SymbolRef;
  fanIn: number;
  fanOut: number;
  adviceCount: number;
}

/** Rank callable symbols by incoming/outgoing call volume. */
export function hotspots(
  store: GraphStore,
  opts: { limit?: number; minFanIn?: number; includeDynamic?: boolean } = {}
): Hotspot[] {
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const minFanIn = opts.minFanIn ?? 0;
  const kinds = sqlKinds(traversalEdgeKinds({ includeDynamic: opts.includeDynamic ?? true }));

  // Pre-aggregate both directions in one scan each, then join the summaries to
  // the callable nodes. The previous form ran three correlated subqueries per
  // candidate row and had to over-fetch `limit * 4` rows because `minFanIn`
  // was applied in JS.
  const rows = store.raw<Row & { fan_in: number; fan_out: number; advice_count: number }>(
    `WITH inbound AS (
       SELECT e.target AS id,
              COUNT(DISTINCT CASE WHEN e.kind IN (${kinds}) THEN e.source END) AS fan_in,
              COUNT(CASE WHEN e.kind = 'ADVISES' THEN 1 END) AS advice_count
       FROM edges e
       WHERE e.kind IN (${kinds}, 'ADVISES')
       GROUP BY e.target
     ),
     outbound AS (
       SELECT e.source AS id, COUNT(DISTINCT e.target) AS fan_out
       FROM edges e
       WHERE e.kind IN (${kinds})
       GROUP BY e.source
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            COALESCE(i.fan_in, 0) AS fan_in,
            COALESCE(o.fan_out, 0) AS fan_out,
            COALESCE(i.advice_count, 0) AS advice_count
     FROM nodes n
     LEFT JOIN inbound i ON i.id = n.id
     LEFT JOIN outbound o ON o.id = n.id
     WHERE n.kind IN ('method', 'constructor')
       AND COALESCE(i.fan_in, 0) >= ?
     ORDER BY fan_in DESC, fan_out DESC, n.qualified_name
     LIMIT ?`,
    minFanIn,
    limit
  );

  return rows.map((r) => ({
    symbol: rowToRef(r),
    fanIn: r.fan_in,
    fanOut: r.fan_out,
    adviceCount: r.advice_count,
  }));
}

export interface DeadSymbol {
  symbol: SymbolRef;
  reason: string;
}

/**
 * Find methods/constructors with no incoming call, dispatch or advice edges.
 * Heuristic: framework entry points, tests and constructors are excluded by
 * default because they are invoked reflectively or by containers.
 */
export function deadCode(
  store: GraphStore,
  opts: {
    limit?: number;
    includeConstructors?: boolean;
    includeTests?: boolean;
    includeDynamic?: boolean;
  } = {}
): DeadSymbol[] {
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const kinds = sqlKinds(traversalEdgeKinds({ includeDynamic: opts.includeDynamic ?? true }));

  const conditions: string[] = [
    "n.kind IN ('method', 'constructor')",
    `NOT EXISTS (
       SELECT 1 FROM edges e
       WHERE e.target = n.id AND e.kind IN (${kinds}, 'ADVISES')
     )`,
    "COALESCE(json_extract(n.properties, '$.name'), '') <> 'main'",
    // Framework-invoked roots are not dead even without an incoming edge.
    "COALESCE(json_extract(n.properties, '$.entryPoint'), 0) <> 1",
  ];
  if (!opts.includeConstructors) conditions.push("n.kind <> 'constructor'");
  if (!opts.includeTests) {
    conditions.push(
      "REPLACE(n.file_path, '\\', '/') NOT LIKE '%/test/%'",
      "REPLACE(n.file_path, '\\', '/') NOT LIKE '%/tests/%'",
      "REPLACE(n.file_path, '\\', '/') NOT LIKE '%/__tests__/%'",
      "n.file_path NOT LIKE '%test\\_%.py' ESCAPE '\\'",
      "n.file_path NOT LIKE '%\\_test.py' ESCAPE '\\'",
      "n.file_path NOT LIKE '%conftest.py'",
      "n.file_path NOT LIKE '%.test.ts'",
      "n.file_path NOT LIKE '%.spec.ts'",
      "n.file_path NOT LIKE '%.test.tsx'",
      "n.file_path NOT LIKE '%.spec.tsx'",
      "n.file_path NOT LIKE '%.test.js'",
      "n.file_path NOT LIKE '%.spec.js'",
      "n.qualified_name NOT LIKE '%Test#%'",
      "n.qualified_name NOT LIKE '%Tests#%'",
      "n.qualified_name NOT LIKE '%IT#%'"
    );
  }

  const rows = store.raw<Row>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE ${conditions.join(" AND ")}
     ORDER BY n.qualified_name
     LIMIT ?`,
    limit
  );

  return rows.map((r) => ({
    symbol: rowToRef(r),
    reason: "no incoming call, dynamic-dispatch or advice edge",
  }));
}

/** A framework-invoked root: nothing in source needs to call it. */
export interface EntryPointRef {
  symbol: SymbolRef;
  entryPointKind: string;
  detail?: string;
}

/**
 * List framework-invoked roots (HTTP routes, listeners, schedulers, events,
 * CLI entry points, tests). These are the seeds a runtime trace starts from.
 */
export function findEntryPoints(
  store: GraphStore,
  opts: { kind?: string; limit?: number } = {}
): EntryPointRef[] {
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const conditions = ["json_extract(n.properties, '$.entryPoint') = 1"];
  const params: unknown[] = [];
  if (opts.kind) {
    conditions.push("json_extract(n.properties, '$.entryPointKind') = ?");
    params.push(opts.kind);
  }
  const rows = store.raw<Row>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE ${conditions.join(" AND ")}
     ORDER BY json_extract(n.properties, '$.entryPointKind'), n.qualified_name
     LIMIT ?`,
    ...params,
    limit
  );

  return rows.map((r) => {
    const props = JSON.parse(r.properties) as {
      entryPointKind?: string;
      entryPointDetail?: string;
    };
    return {
      symbol: rowToRef(r),
      entryPointKind: props.entryPointKind ?? "unknown",
      ...(props.entryPointDetail ? { detail: props.entryPointDetail } : {}),
    };
  });
}

/** An edge representing framework wiring rather than a source-level call. */
export interface WiringEdge {
  source: SymbolRef;
  target: SymbolRef;
  line?: number;
  framework?: string;
  external?: boolean;
  /** INJECTS: injected field/parameter name. */
  injectedName?: string;
  /** REFLECTS: the run-time lookup mechanism. */
  mechanism?: string;
  /** ROUTES: HTTP verb and path. */
  httpMethod?: string;
  path?: string;
}

function wiringEdges(
  store: GraphStore,
  kind: EdgeKind,
  symbol: string | undefined,
  limit: number
): WiringEdge[] {
  const anchor = symbol ? resolveNode(store, symbol) : null;
  if (symbol && !anchor) return [];
  const rows = store.raw<WiringRow>(
    `SELECT e.properties AS edge_props, e.source AS source_id, e.target AS target_id,
            s.id AS s_id, s.qualified_name AS s_qn, s.kind AS s_kind, s.file_path AS s_file, s.properties AS s_props,
            t.id AS t_id, t.qualified_name AS t_qn, t.kind AS t_kind, t.file_path AS t_file, t.properties AS t_props
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE e.kind = ?
       ${anchor ? "AND (e.source = ? OR e.target = ?)" : ""}
     ORDER BY s.qualified_name, t.qualified_name
     LIMIT ?`,
    ...(anchor ? [kind, anchor.id, anchor.id, limit] : [kind, limit])
  );

  return rows.map((r) => {
    const props = JSON.parse(r.edge_props ?? "{}") as {
      line?: number;
      framework?: string;
      external?: boolean;
      injectedName?: string;
      mechanism?: string;
      httpMethod?: string;
      path?: string;
    };
    return {
      source: rowToRef({
        id: r.s_id,
        qualified_name: r.s_qn,
        kind: r.s_kind,
        file_path: r.s_file,
        properties: r.s_props,
      }),
      target: rowToRef({
        id: r.t_id,
        qualified_name: r.t_qn,
        kind: r.t_kind,
        file_path: r.t_file,
        properties: r.t_props,
      }),
      ...(typeof props.line === "number" ? { line: props.line } : {}),
      ...(props.framework ? { framework: props.framework } : {}),
      ...(props.external ? { external: props.external } : {}),
      ...(props.injectedName ? { injectedName: props.injectedName } : {}),
      ...(props.mechanism ? { mechanism: props.mechanism } : {}),
      ...(props.httpMethod ? { httpMethod: props.httpMethod } : {}),
      ...(props.path ? { path: props.path } : {}),
    };
  });
}

/** Dependencies supplied by a DI container (Spring, NestJS, FastAPI, ...). */
export function findInjections(
  store: GraphStore,
  opts: { symbol?: string; limit?: number } = {}
): WiringEdge[] {
  return wiringEdges(store, "INJECTS", opts.symbol, opts.limit ?? store.defaultLimit ?? 50);
}

/** Run-time lookups: reflection, `getattr`, dynamic `import()`, `require`. */
export function findReflections(
  store: GraphStore,
  opts: { symbol?: string; limit?: number } = {}
): WiringEdge[] {
  return wiringEdges(store, "REFLECTS", opts.symbol, opts.limit ?? store.defaultLimit ?? 50);
}

/** Route registrations mapped to the handler they invoke. */
export function findRoutes(
  store: GraphStore,
  opts: { symbol?: string; limit?: number } = {}
): WiringEdge[] {
  return wiringEdges(store, "ROUTES", opts.symbol, opts.limit ?? store.defaultLimit ?? 50);
}

export interface ExternalDependency {
  package: string;
  /** Number of edges pointing at the external package. */
  references: number;
  /** Number of distinct project files using it. */
  files: number;
  /** Edge kinds that reference it. */
  kinds: string[];
}

/** Third-party packages the crawled source depends on. */
export function externalDependencies(
  store: GraphStore,
  opts: { limit?: number } = {}
): ExternalDependency[] {
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const rows = store.raw<{ package: string; references: number; files: number; kinds: string }>(
    `SELECT t.qualified_name AS package,
            COUNT(*) AS "references",
            COUNT(DISTINCT s.file_path) AS "files",
            GROUP_CONCAT(DISTINCT e.kind) AS kinds
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE t.kind = 'external_symbol'
     GROUP BY t.id
     ORDER BY "references" DESC, package
     LIMIT ?`,
    limit
  );

  return rows.map((r) => ({
    package: r.package.replace(/^ext:/, ""),
    references: r.references,
    files: r.files,
    kinds: (r.kinds ?? "").split(",").filter((k) => k.length > 0),
  }));
}

interface WiringRow {
  edge_props: string | null;
  s_id: string;
  s_qn: string;
  s_kind: NodeKind;
  s_file: string | null;
  s_props: string;
  t_id: string;
  t_qn: string;
  t_kind: NodeKind;
  t_file: string | null;
  t_props: string;
}

export interface Row {
  id: string;
  qualified_name: string;
  kind: NodeKind;
  file_path: string | null;
  properties: string;
  depth?: number;
}

interface RowWithEdge extends Row {
  edge_props?: string;
}

export function rowToRef(r: Row): SymbolRef {
  return {
    id: r.id,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    filePath: r.file_path,
    name: (JSON.parse(r.properties) as { name?: string }).name,
  };
}

export function edgeLine(props: string | undefined): number | undefined {
  if (!props) return undefined;
  const line = (JSON.parse(props) as { line?: number }).line;
  return typeof line === "number" ? line : undefined;
}

/** Extract the control-flow context recorded on an edge, if any. */
function edgeFlow(props: string | undefined): FlowEdgeInfo {
  if (!props) return {};
  const parsed = JSON.parse(props) as {
    conditional?: boolean;
    controlFlow?: string[];
    guards?: string[];
  };
  const out: FlowEdgeInfo = {};
  if (typeof parsed.conditional === "boolean") out.conditional = parsed.conditional;
  if (Array.isArray(parsed.controlFlow) && parsed.controlFlow.length > 0) {
    out.controlFlow = parsed.controlFlow;
  }
  if (Array.isArray(parsed.guards) && parsed.guards.length > 0) out.guards = parsed.guards;
  return out;
}
