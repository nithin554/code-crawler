import type { GraphStore } from "./store.js";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from "./schema.js";

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
  /** Properties of the CALLS edge (call site line, resolution, confidence). */
  callSiteLine?: number;
  resolved?: boolean;
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

export interface CallerQueryOptions {
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
): { target: SymbolRef; callers: { caller: SymbolRef; depth: number; callSiteLine?: number }[] } | null {
  const target = resolveNode(store, symbol);
  if (!target) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;

  if (!transitive) {
    const rows = store.raw(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, e.properties AS edge_props
       FROM edges e
       JOIN nodes n ON n.id = e.source
       WHERE e.target = ? AND e.kind = 'CALLS'
       ORDER BY e.source
       LIMIT ?`,
      symbol,
      limit
    ) as RowWithEdge[];
    return {
      target: nodeToRef(target),
      callers: rows.map((r) => ({
        caller: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
      })),
    };
  }

  const rows = store.raw(
    `WITH RECURSIVE callers(id, depth, path) AS (
       SELECT e.source, 1, e.source || '/' || e.target
       FROM edges e
       WHERE e.target = ? AND e.kind = 'CALLS'
       UNION ALL
       SELECT e.source, c.depth + 1, c.path || '/' || e.source
       FROM edges e
       JOIN callers c ON e.target = c.id
       WHERE e.kind = 'CALLS'
         AND c.depth < ?
         AND e.source || '/' || e.target NOT LIKE c.path || '/%'
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, c.depth
     FROM callers c
     JOIN nodes n ON n.id = c.id
     ORDER BY c.depth, n.id
     LIMIT ?`,
    symbol,
    maxDepth,
    limit
  ) as (Row & { depth: number })[];

  return {
    target: nodeToRef(target),
    callers: rows.map((r) => ({ caller: rowToRef(r), depth: r.depth })),
  };
}

export interface CalleeQueryOptions {
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
): { source: SymbolRef; callees: { callee: SymbolRef; depth: number; callSiteLine?: number }[] } | null {
  const source = resolveNode(store, symbol);
  if (!source) return null;

  const transitive = opts.transitive ?? true;
  const maxDepth = Math.max(1, opts.maxDepth ?? store.maxDepth ?? 10);
  const limit = opts.limit ?? 100;

  if (!transitive) {
    const rows = store.raw(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, e.properties AS edge_props
       FROM edges e
       JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'CALLS'
       ORDER BY e.target
       LIMIT ?`,
      symbol,
      limit
    ) as RowWithEdge[];
    return {
      source: nodeToRef(source),
      callees: rows.map((r) => ({
        callee: rowToRef(r),
        depth: 1,
        callSiteLine: edgeLine(r.edge_props),
      })),
    };
  }

  const rows = store.raw(
    `WITH RECURSIVE callees(id, depth, path) AS (
       SELECT e.target, 1, e.source || '/' || e.target
       FROM edges e
       WHERE e.source = ? AND e.kind = 'CALLS'
       UNION ALL
       SELECT e.target, c.depth + 1, c.path || '/' || e.target
       FROM edges e
       JOIN callees c ON e.source = c.id
       WHERE e.kind = 'CALLS'
         AND c.depth < ?
         AND e.source || '/' || e.target NOT LIKE c.path || '/%'
     )
     SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, c.depth
     FROM callees c
     JOIN nodes n ON n.id = c.id
     ORDER BY c.depth, n.id
     LIMIT ?`,
    symbol,
    maxDepth,
    limit
  ) as (Row & { depth: number })[];

  return {
    source: nodeToRef(source),
    callees: rows.map((r) => ({ callee: rowToRef(r), depth: r.depth })),
  };
}

export interface PathEntry {
  /** Ordered list of symbol ids from source to target (inclusive). */
  path: string[];
  length: number;
  edges: {
    source: string;
    target: string;
    callSiteLine?: number;
    resolved?: boolean;
  }[];
}

export interface TracePathOptions {
  maxDepth?: number;
  limit?: number;
}

/**
 * Find up to `limit` static call paths between two symbols.
 * BFS over CALLS edges so the shortest paths come first.
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

  // BFS in SQL via recursive CTE that accumulates the path taken.
  const rows = store.raw(
    `WITH RECURSIVE paths(id, depth, path, edge_path) AS (
       SELECT e.target, 1, e.source || '/' || e.target, e.source || '/' || e.target
       FROM edges e
       WHERE e.source = ? AND e.kind = 'CALLS'
       UNION ALL
       SELECT e.target, p.depth + 1, p.path || '/' || e.target, p.edge_path || '|' || e.source || '/' || e.target
       FROM edges e
       JOIN paths p ON e.source = p.id
       WHERE e.kind = 'CALLS'
         AND p.depth < ?
         AND instr('|' || p.path || '|', '|' || e.target || '|') = 0
     )
     SELECT path, edge_path, depth
     FROM paths
     WHERE id = ?
     ORDER BY depth
     LIMIT ?`,
    from,
    maxDepth,
    to,
    limit
  ) as { path: string; edge_path: string; depth: number }[];

  return rows.map((r) => {
    const ids = r.path.split("/");
    const edges = r.edge_path.split("|").map((pair) => {
      const [src, tgt] = pair.split("/");
      return { source: src ?? "", target: tgt ?? "" };
    });
    return { path: ids, length: r.depth, edges };
  });
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
  const edgeKinds = opts.edgeKinds ?? ["CALLS", "DECLARED_IN", "CONTAINS", "EXTENDS", "IMPLEMENTS", "REFERENCES", "IMPORTS"];
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
    symbol,
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

  // Re-rank: exact-qualified-name matches first.
  return rows
    .map((r) => rowToRef(r))
    .sort((a, b) => rank(a, q) - rank(b, q));
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
