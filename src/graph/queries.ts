import type { GraphStore } from "./store.js";
import { annotationNodeId } from "./schema.js";
import type { EdgeKind, GraphNode, NodeKind } from "./schema.js";

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

function nodeToRef(node: GraphNode): SymbolRef {
  return {
    id: node.id,
    qualifiedName: node.qualifiedName,
    name: node.properties.name,
    kind: node.kind,
    filePath: node.filePath,
  };
}

/** Resolve a node by exact id or by qualified name, favoring id. */
function resolveNode(store: GraphStore, symbol: string): GraphNode | null {
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

function sqlKinds(kinds: EdgeKind[]): string {
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
  callers: { caller: SymbolRef; depth: number; callSiteLine?: number; edgeKind: EdgeKind }[];
} | null {
  const target = resolveNode(store, symbol);
  if (!target) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;
  const kinds = traversalEdgeKinds(opts);

  if (!transitive) {
    const rows = store.raw(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
              e.properties AS edge_props, e.kind AS edge_kind
       FROM edges e
       JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind IN (${sqlKinds(kinds)})
       ORDER BY e.kind, e.source
       LIMIT ?`,
      target.id,
      limit
    ) as (RowWithEdge & { edge_kind: EdgeKind })[];
    return {
      target: nodeToRef(target),
      callers: rows.map((r) => ({
        caller: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
        edgeKind: r.edge_kind,
      })),
    };
  }

  const rows = store.raw(
    `WITH RECURSIVE callers(id, depth, path, edge_kind, edge_props) AS (
       SELECT e.source, 1, e.source || '/' || e.target, e.kind, e.properties
       FROM edges e
       WHERE e.target = ? AND e.kind IN (${sqlKinds(kinds)})
       UNION ALL
       SELECT e.source, c.depth + 1, c.path || '/' || e.source, e.kind, e.properties
       FROM edges e
       JOIN callers c ON e.target = c.id
       WHERE e.kind IN (${sqlKinds(kinds)})
         AND c.depth < ?
         AND instr('|' || c.path || '|', '|' || e.source || '|') = 0
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            c.depth, c.edge_kind, c.edge_props
     FROM callers c
     JOIN nodes n ON n.id = c.id
     ORDER BY c.depth, n.id
     LIMIT ?`,
    target.id,
    maxDepth,
    limit
  ) as (RowWithEdge & { depth: number; edge_kind: EdgeKind })[];

  return {
    target: nodeToRef(target),
    callers: rows.map((r) => ({
      caller: rowToRef(r),
      depth: r.depth,
      callSiteLine: edgeLine(r.edge_props),
      edgeKind: r.edge_kind,
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
  callees: { callee: SymbolRef; depth: number; callSiteLine?: number; edgeKind: EdgeKind }[];
} | null {
  const source = resolveNode(store, symbol);
  if (!source) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;
  const kinds = traversalEdgeKinds(opts);

  if (!transitive) {
    const rows = store.raw(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
              e.properties AS edge_props, e.kind AS edge_kind
       FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind IN (${sqlKinds(kinds)})
       ORDER BY e.kind, e.target
       LIMIT ?`,
      source.id,
      limit
    ) as (RowWithEdge & { edge_kind: EdgeKind })[];
    return {
      source: nodeToRef(source),
      callees: rows.map((r) => ({
        callee: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
        edgeKind: r.edge_kind,
      })),
    };
  }

  const rows = store.raw(
    `WITH RECURSIVE callees(id, depth, path, edge_kind, edge_props) AS (
       SELECT e.target, 1, e.source || '/' || e.target, e.kind, e.properties
       FROM edges e
       WHERE e.source = ? AND e.kind IN (${sqlKinds(kinds)})
       UNION ALL
       SELECT e.target, c.depth + 1, c.path || '/' || e.target, e.kind, e.properties
       FROM edges e
       JOIN callees c ON e.source = c.id
       WHERE e.kind IN (${sqlKinds(kinds)})
         AND c.depth < ?
         AND instr('|' || c.path || '|', '|' || e.target || '|') = 0
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            c.depth, c.edge_kind, c.edge_props
     FROM callees c
     JOIN nodes n ON n.id = c.id
     ORDER BY c.depth, n.id
     LIMIT ?`,
    source.id,
    maxDepth,
    limit
  ) as (RowWithEdge & { depth: number; edge_kind: EdgeKind })[];

  return {
    source: nodeToRef(source),
    callees: rows.map((r) => ({
      callee: rowToRef(r),
      depth: r.depth,
      callSiteLine: edgeLine(r.edge_props),
      edgeKind: r.edge_kind,
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
  const rows = store.raw(
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
  ) as { path: string; edge_path: string; depth: number }[];

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
      const props = store.raw(
        "SELECT properties FROM edges WHERE source = ? AND target = ? AND kind = ? LIMIT 1",
        edge.source,
        edge.target,
        edge.kind
      ) as { properties: string }[];
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

  const rows = store.raw(
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
  ) as (RowWithEdge & { depth: number; via: EdgeKind | "INTERCEPT" | null; step_props: string | null })[];

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
  const edgeKinds =
    opts.edgeKinds ??
    [
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
    ];
  const limit = opts.limit ?? 500;

  const kinds = edgeKinds.map((k) => `'${k}'`).join(",");
  const rows = store.raw(
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
  ) as Row[];

  const nodes = rows.map(rowToRef);
  const ids = nodes.map((n) => n.id);
  if (ids.length === 0) return { center: nodeToRef(center), nodes, edges: [] };

  const placeholders = ids.map(() => "?").join(",");
  const edgeRows = store.raw(
    `SELECT source, target, kind, properties
     FROM edges
     WHERE kind IN (${kinds})
       AND source IN (${placeholders}) AND target IN (${placeholders})
     LIMIT ?`,
    ...ids,
    ...ids,
    limit
  ) as { source: string; target: string; kind: EdgeKind; properties: string }[];

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
 * Fuzzy symbol lookup by short name or FQN. Matches substring of either the
 * id, the qualified name, or the display name.
 */
export function searchSymbols(
  store: GraphStore,
  query: string,
  opts: SearchOptions = {}
): SymbolRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? store.defaultLimit ?? 50;
  const like = `%${q}%`;

  const kindClause = opts.kind ? "AND n.kind = ?" : "";
  const params: unknown[] = [like, like, like];
  if (opts.kind) params.push(opts.kind);
  // ORDER BY CASE params: exact-qualified-name, then prefix/name match
  params.push(q, like, limit);

  const rows = store.raw(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE LOWER(n.id) LIKE ? OR LOWER(n.qualified_name) LIKE ? OR LOWER(n.properties) LIKE ?
     ${kindClause}
     ORDER BY
       CASE WHEN LOWER(n.qualified_name) = ? THEN 0
            WHEN LOWER(n.id) LIKE ? THEN 1
            ELSE 2 END,
       n.qualified_name
     LIMIT ?`,
    ...params
  ) as Row[];

  // Re-rank: exact name matches first, then keep alphabetical ordering so the
  // SQL ordering is not silently discarded.
  return rows
    .map((r) => rowToRef(r))
    .sort((a, b) => rank(a, q) - rank(b, q) || a.qualifiedName.localeCompare(b.qualifiedName));
}

function rank(ref: SymbolRef, q: string): number {
  if (ref.qualifiedName.toLowerCase() === q) return 0;
  const name = ref.name?.toLowerCase() ?? "";
  if (name === q) return 1;
  if (ref.qualifiedName.toLowerCase().startsWith(q)) return 2;
  return 3;
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

  const rows = store.raw(
    `WITH RECURSIVE impl(id, depth, path, via) AS (
       SELECT e.source, 1, e.source || '/' || e.target, e.kind
       FROM edges e
       WHERE e.target = ? AND e.kind IN ('EXTENDS', 'IMPLEMENTS')
       UNION ALL
       SELECT e.source, i.depth + 1, i.path || '/' || e.source, e.kind
       FROM edges e
       JOIN impl i ON e.target = i.id
       WHERE e.kind IN ('EXTENDS', 'IMPLEMENTS')
         AND i.depth < ?
         AND instr('|' || i.path || '|', '|' || e.source || '|') = 0
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
            i.depth, i.via
     FROM impl i
     JOIN nodes n ON n.id = i.id
     WHERE n.kind IN ('class', 'interface', 'enum', 'aspect', 'annotation_type')
     ORDER BY i.depth, n.qualified_name
     LIMIT ?`,
    target.id,
    maxDepth,
    limit
  ) as (Row & { depth: number; via: "EXTENDS" | "IMPLEMENTS" })[];

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
  const aspectRows = store.raw(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE n.kind = 'aspect'
     ORDER BY n.qualified_name
     LIMIT ?`,
    limit
  ) as Row[];

  return aspectRows.map((row) => {
    const aspect = rowToRef(row);
    const members = store.raw(
      `SELECT m.id, m.qualified_name, m.kind, m.file_path, m.properties
       FROM edges e
       JOIN nodes m ON m.id = e.target
       WHERE e.source = ? AND e.kind = 'CONTAINS'
         AND m.kind = 'method'
       ORDER BY m.qualified_name`,
      aspect.id
    ) as Row[];

    const advice: AdviceDetail[] = [];
    for (const member of members) {
      const props = JSON.parse(member.properties) as {
        adviceKind?: string;
        pointcut?: string;
      };
      const advisedRows = store.raw(
        `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
         FROM edges e
         JOIN nodes n ON n.id = e.target
         WHERE e.source = ? AND e.kind = 'ADVISES'
         ORDER BY n.qualified_name`,
        member.id
      ) as Row[];
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
  const rows = store.raw(
    `SELECT a.qualified_name, a.properties AS ann_props, e.properties AS edge_props
     FROM edges e
     JOIN nodes a ON a.id = e.target
     WHERE e.kind = 'ANNOTATED_WITH' AND e.source IN (${placeholders})
     ORDER BY a.qualified_name`,
    ...ids
  ) as { qualified_name: string; ann_props: string; edge_props: string }[];

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

  const memberRows = store.raw(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM edges e
     JOIN nodes n ON n.id = e.target
     WHERE e.source = ? AND e.kind = 'CONTAINS'
       AND n.kind IN ('method', 'constructor', 'field')
     ORDER BY n.qualified_name`,
    node.id
  ) as Row[];

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

  const params: unknown[] = [
    annotationNodeId(name),
    name,
    `%.${name}`,
    `%"name":"${name}"%`,
  ];
  if (opts.kind) params.push(opts.kind);
  params.push(limit);

  const rows = store.raw(
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
  ) as (Row & { ann_props: string; edge_props: string })[];

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

  const rows = store.raw(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties,
       (SELECT COUNT(DISTINCT e.source) FROM edges e
          WHERE e.target = n.id AND e.kind IN (${kinds})) AS fan_in,
       (SELECT COUNT(DISTINCT e.target) FROM edges e
          WHERE e.source = n.id AND e.kind IN (${kinds})) AS fan_out,
       (SELECT COUNT(*) FROM edges e
          WHERE e.target = n.id AND e.kind = 'ADVISES') AS advice_count
     FROM nodes n
     WHERE n.kind IN ('method', 'constructor')
     ORDER BY fan_in DESC, fan_out DESC, n.qualified_name
     LIMIT ?`,
    limit * 4
  ) as (Row & { fan_in: number; fan_out: number; advice_count: number })[];

  return rows
    .filter((r) => r.fan_in >= minFanIn)
    .slice(0, limit)
    .map((r) => ({
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
  ];
  if (!opts.includeConstructors) conditions.push("n.kind <> 'constructor'");
  if (!opts.includeTests) {
    conditions.push(
      "REPLACE(n.file_path, '\\', '/') NOT LIKE '%/test/%'",
      "REPLACE(n.file_path, '\\', '/') NOT LIKE '%/tests/%'",
      "n.qualified_name NOT LIKE '%Test#%'",
      "n.qualified_name NOT LIKE '%Tests#%'",
      "n.qualified_name NOT LIKE '%IT#%'"
    );
  }

  const rows = store.raw(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
     FROM nodes n
     WHERE ${conditions.join(" AND ")}
     ORDER BY n.qualified_name
     LIMIT ?`,
    limit
  ) as Row[];

  return rows.map((r) => ({
    symbol: rowToRef(r),
    reason: "no incoming call, dynamic-dispatch or advice edge",
  }));
}

interface Row {
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

function rowToRef(r: Row): SymbolRef {
  return {
    id: r.id,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    filePath: r.file_path,
    name: (JSON.parse(r.properties) as { name?: string }).name,
  };
}

function edgeLine(props: string | undefined): number | undefined {
  if (!props) return undefined;
  const line = (JSON.parse(props) as { line?: number }).line;
  return typeof line === "number" ? line : undefined;
}
