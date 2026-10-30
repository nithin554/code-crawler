/**
 * Higher-level analyses built on top of the primitive queries.
 *
 * These power the "agent-facing" tools: what the index could not resolve, what
 * breaks if a symbol changes, a one-shot explanation of a symbol, call cycles,
 * and graph export in diagram formats.
 */

import {
  type DecoratorInfo,
  edgeLine,
  findEntryPoints,
  findImplementations,
  findInjections,
  findReflections,
  findRoutes,
  getCallees,
  getCallers,
  getDecorators,
  getSubgraph,
  nodeToRef,
  type Row,
  resolveNode,
  rowToRef,
  type SymbolRef,
  sqlKinds,
  type WiringEdge,
} from "./queries.js";
import type { EdgeKind, NodeKind } from "./schema.js";
import type { GraphStore } from "./store.js";

const UNKNOWN_PREFIX = "__unknown__:";

/** Edge properties recorded on unresolvable call sites. */
interface CallEdgeProps {
  line?: number;
  resolved?: boolean;
  confidence?: number;
  reason?: string;
}

function parseProps<T>(raw: string | undefined): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

/* ------------------------------------------------------------------ */
/* Unresolved calls                                                    */
/* ------------------------------------------------------------------ */

export interface UnresolvedCall {
  caller: SymbolRef;
  /** Placeholder node id the call edge points at (`__unknown__:<label>`). */
  targetId: string;
  /** Callee as written in source, e.g. `System.out.println`. */
  targetLabel: string;
  /** Why the resolver gave up. */
  reason: string;
  line?: number;
  edgeKind: EdgeKind;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface UnresolvedReport {
  /** Total unresolved call edges matching the filters, ignoring `limit`. */
  total: number;
  /** Unresolved edges grouped by resolver reason, most frequent first. */
  byReason: ReasonCount[];
  calls: UnresolvedCall[];
  /** True when `calls` hit the scan limit before `total` did. */
  scanTruncated: boolean;
  /** `kind` filter that was applied to the caller node kind. */
  callerKind?: NodeKind;
  /** `reason` filter that was applied (substring, case-insensitive). */
  reasonFilter?: string;
}

export interface UnresolvedQueryOptions {
  /** Substring match against the resolver reason, case-insensitive. */
  reason?: string;
  /** Restrict to unresolved calls made by callers of this node kind. */
  kind?: NodeKind;
  /** Cap on rows scanned (default 2000). */
  limit?: number;
}

/**
 * Every call the resolver could not bind to a node, with the reason it failed.
 *
 * Unresolved calls are the honest boundary of a static index: they show where
 * analysis stops (dynamic dispatch, untyped receivers, missing dependencies)
 * and they are the highest-signal input for improving the parsers.
 */
export function findUnresolved(
  store: GraphStore,
  opts: UnresolvedQueryOptions = {}
): UnresolvedReport {
  const limit = Math.max(1, opts.limit ?? 2000);
  const conditions = ["e.kind = 'CALLS'", "json_extract(e.properties, '$.resolved') = 0"];
  const params: unknown[] = [];
  if (opts.kind) {
    conditions.push("s.kind = ?");
    params.push(opts.kind);
  }
  if (opts.reason) {
    conditions.push("LOWER(COALESCE(json_extract(e.properties, '$.reason'), '')) LIKE ?");
    params.push(`%${opts.reason.toLowerCase()}%`);
  }
  const where = conditions.join(" AND ");

  const reasonRows = store.raw<{ reason: string | null; count: number }>(
    `SELECT json_extract(e.properties, '$.reason') AS reason, COUNT(*) AS count
     FROM edges e
     JOIN nodes s ON s.id = e.source
     WHERE ${where}
     GROUP BY reason
     ORDER BY count DESC, reason`,
    ...params
  );

  const rows = store.raw<Row & { target_id: string; edge_props: string }>(
    `SELECT s.id, s.qualified_name, s.kind, s.file_path, s.properties,
            e.target AS target_id, e.properties AS edge_props
     FROM edges e
     JOIN nodes s ON s.id = e.source
     WHERE ${where}
     ORDER BY s.qualified_name, json_extract(e.properties, '$.line')
     LIMIT ?`,
    ...params,
    limit
  );

  const byReason: ReasonCount[] = reasonRows.map((r) => ({
    reason: r.reason ?? "unresolved",
    count: r.count,
  }));
  const total = byReason.reduce((sum, r) => sum + r.count, 0);

  return {
    total,
    byReason,
    calls: rows.map((r) => {
      const props = parseProps<CallEdgeProps>(r.edge_props);
      const line = typeof props.line === "number" ? props.line : undefined;
      return {
        caller: rowToRef(r),
        targetId: r.target_id,
        targetLabel: r.target_id.startsWith(UNKNOWN_PREFIX)
          ? r.target_id.slice(UNKNOWN_PREFIX.length)
          : r.target_id,
        reason: props.reason ?? "unresolved",
        ...(line !== undefined ? { line } : {}),
        edgeKind: "CALLS" as EdgeKind,
      };
    }),
    scanTruncated: total > rows.length,
    ...(opts.kind ? { callerKind: opts.kind } : {}),
    ...(opts.reason ? { reasonFilter: opts.reason } : {}),
  };
}

export interface NodeUnresolvedInfo {
  /** Calls this node makes that could not be resolved. */
  outgoing: UnresolvedCall[];
  /** Unresolved calls elsewhere in the graph that point at this node. */
  incoming: { caller: SymbolRef; line?: number }[];
}

/**
 * Unresolved call detail for a single node, used to annotate `get_node`.
 * Returns `undefined` when the node has no unresolved edges in either
 * direction so callers can omit the block entirely.
 */
export function unresolvedForNode(
  store: GraphStore,
  nodeId: string
): NodeUnresolvedInfo | undefined {
  const outgoingRows = store.raw<Row & { target_id: string; edge_props: string }>(
    `SELECT s.id, s.qualified_name, s.kind, s.file_path, s.properties,
            e.target AS target_id, e.properties AS edge_props
     FROM edges e
     JOIN nodes s ON s.id = e.source
     WHERE e.kind = 'CALLS'
       AND json_extract(e.properties, '$.resolved') = 0
       AND e.source = ?
     ORDER BY json_extract(e.properties, '$.line')`,
    nodeId
  );

  const incomingRows = store.raw<Row & { edge_props: string }>(
    `SELECT s.id, s.qualified_name, s.kind, s.file_path, s.properties, e.properties AS edge_props
     FROM edges e
     JOIN nodes s ON s.id = e.source
     WHERE e.kind = 'CALLS'
       AND json_extract(e.properties, '$.resolved') = 0
       AND e.target = ?
     ORDER BY s.qualified_name`,
    nodeId
  );

  if (outgoingRows.length === 0 && incomingRows.length === 0) return undefined;

  return {
    outgoing: outgoingRows.map((r) => {
      const props = parseProps<CallEdgeProps>(r.edge_props);
      const line = typeof props.line === "number" ? props.line : undefined;
      return {
        caller: rowToRef(r),
        targetId: r.target_id,
        targetLabel: r.target_id.startsWith(UNKNOWN_PREFIX)
          ? r.target_id.slice(UNKNOWN_PREFIX.length)
          : r.target_id,
        reason: props.reason ?? "unresolved",
        ...(line !== undefined ? { line } : {}),
        edgeKind: "CALLS" as EdgeKind,
      };
    }),
    incoming: incomingRows.map((r) => {
      const line = edgeLine(r.edge_props);
      return { caller: rowToRef(r), ...(line !== undefined ? { line } : {}) };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Impact analysis                                                     */
/* ------------------------------------------------------------------ */

export interface ImpactCaller {
  caller: SymbolRef;
  depth: number;
  callSiteLine?: number;
  edgeKind: EdgeKind;
}

export interface ImpactImplementation {
  type: SymbolRef;
  /** Override of the analyzed method, when the symbol is a member. */
  method?: SymbolRef;
  depth: number;
  via: "EXTENDS" | "IMPLEMENTS";
}

export interface ImpactSummary {
  totalCallers: number;
  directCallers: number;
  entryPoints: number;
  routes: number;
  implementations: number;
  affectedFiles: number;
  /**
   * Heuristic blast radius: `high` when a framework entry point reaches the
   * symbol, `medium` when at least one caller exists, else `low`.
   */
  risk: "low" | "medium" | "high";
}

export interface ImpactAnalysis {
  symbol: SymbolRef;
  summary: ImpactSummary;
  callers: ImpactCaller[];
  entryPoints: { symbol: SymbolRef; entryPointKind: string; detail?: string; viaDepth?: number }[];
  routes: WiringEdge[];
  implementations: ImpactImplementation[];
  affectedFiles: string[];
}

export interface ImpactOptions {
  maxDepth?: number;
  includeDynamic?: boolean;
  limit?: number;
}

function enclosingTypeId(id: string): string | undefined {
  const hash = id.lastIndexOf("#");
  return hash > 0 ? id.slice(0, hash) : undefined;
}

function memberName(id: string): string | undefined {
  const hash = id.lastIndexOf("#");
  return hash > 0 && hash < id.length - 1 ? id.slice(hash + 1) : undefined;
}

/**
 * "What breaks if I change this?" — reverse callers, framework entry points,
 * routes and implementations in a single response.
 *
 * A type aggregates the callers of its contained methods, since call edges bind
 * to methods and a class is usually changed through its members.
 */
export function impactAnalysis(
  store: GraphStore,
  symbol: string,
  opts: ImpactOptions = {}
): ImpactAnalysis | null {
  const node = resolveNode(store, symbol);
  if (!node) return null;

  const pageLimit = Math.max(1, opts.limit ?? 200);

  // Calls bind to methods, so analysing a type must also cover its members.
  const targets: string[] = [node.id];
  if (node.kind !== "method" && node.kind !== "constructor") {
    const memberRows = store.raw<{ id: string }>(
      `SELECT n.id
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE e.source = ? AND e.kind = 'CONTAINS'
         AND n.kind IN ('method', 'constructor')
       LIMIT 1000`,
      node.id
    );
    for (const row of memberRows) if (row.id !== node.id) targets.push(row.id);
  }

  const merged = new Map<string, ImpactCaller>();
  for (const target of targets) {
    const reverse = getCallers(store, target, {
      transitive: true,
      maxDepth: opts.maxDepth,
      includeDynamic: opts.includeDynamic ?? true,
      limit: pageLimit,
    });
    for (const c of reverse?.callers ?? []) {
      const existing = merged.get(c.caller.id);
      if (existing && existing.depth <= c.depth) continue;
      merged.set(c.caller.id, {
        caller: c.caller,
        depth: c.depth,
        ...(c.callSiteLine !== undefined ? { callSiteLine: c.callSiteLine } : {}),
        edgeKind: c.edgeKind,
      });
    }
  }
  const callers = [...merged.values()]
    .sort((a, b) => a.depth - b.depth || a.caller.id.localeCompare(b.caller.id))
    .slice(0, pageLimit);

  // Implementation overrides: for a type, the subclasses; for a method, the
  // same-named member on every subclass so a signature change is visible.
  const implementations: ImpactImplementation[] = [];
  const typeId =
    node.kind === "method" || node.kind === "constructor" ? enclosingTypeId(node.id) : node.id;
  if (typeId) {
    const impls = findImplementations(store, typeId, { maxDepth: opts.maxDepth, limit: 500 });
    const name = memberName(node.id);
    for (const impl of impls?.implementations ?? []) {
      const entry: ImpactImplementation = {
        type: impl.type,
        depth: impl.depth,
        via: impl.via,
      };
      if (name && typeId !== node.id) {
        const override =
          store.getNode(`${impl.type.id}#${name}`) ??
          store.getNodeByQualifiedName(`${impl.type.qualifiedName}#${name}`);
        if (override) entry.method = nodeToRef(override);
      }
      implementations.push(entry);
    }
  }

  // Framework entry points that reach this symbol through the call graph.
  const reachable = new Map<string, number>();
  for (const c of callers) {
    if (!reachable.has(c.caller.id) || (reachable.get(c.caller.id) ?? 0) > c.depth) {
      reachable.set(c.caller.id, c.depth);
    }
  }
  reachable.set(node.id, 0);
  for (const target of targets) reachable.set(target, 0);
  const entryPointRows = findEntryPoints(store, { limit: 10000 });
  const entryPoints = entryPointRows
    .filter((e) => reachable.has(e.symbol.id))
    .map((e) => ({
      symbol: e.symbol,
      entryPointKind: e.entryPointKind,
      ...(e.detail ? { detail: e.detail } : {}),
      viaDepth: reachable.get(e.symbol.id) ?? 0,
    }));

  const targetSet = new Set(targets);
  const routeRows = findRoutes(store, { limit: 10000 });
  const routes = routeRows.filter((r) => targetSet.has(r.target.id) || targetSet.has(r.source.id));

  const files = new Set<string>();
  if (node.filePath) files.add(node.filePath);
  for (const c of callers) if (c.caller.filePath) files.add(c.caller.filePath);
  for (const i of implementations) if (i.type.filePath) files.add(i.type.filePath);

  const directCallers = callers.filter((c) => c.depth === 1).length;
  const risk: ImpactSummary["risk"] =
    entryPoints.length > 0 ? "high" : directCallers > 0 ? "medium" : "low";

  return {
    symbol: nodeToRef(node),
    summary: {
      totalCallers: callers.length,
      directCallers,
      entryPoints: entryPoints.length,
      routes: routes.length,
      implementations: implementations.length,
      affectedFiles: files.size,
      risk,
    },
    callers,
    entryPoints,
    routes,
    implementations,
    affectedFiles: [...files].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Symbol explanation                                                  */
/* ------------------------------------------------------------------ */

export interface ExplainedMember {
  symbol: SymbolRef;
  line?: number;
  decorators: DecoratorInfo[];
}

export interface SymbolExplanation {
  symbol: SymbolRef;
  line?: number;
  isEntryPoint?: boolean;
  decorators: DecoratorInfo[];
  members: ExplainedMember[];
  callers: ImpactCaller[];
  callees: ImpactCaller[];
  implementations: ImpactImplementation[];
  routes: WiringEdge[];
  injections: WiringEdge[];
  reflections: WiringEdge[];
  summary: {
    members: number;
    callers: number;
    callees: number;
    implementations: number;
    wiringEdges: number;
  };
}

export interface ExplainOptions {
  maxDepth?: number;
  includeDynamic?: boolean;
  limit?: number;
}

/**
 * One-shot digest of a symbol: what it is, what it is annotated with, what it
 * contains, who calls it, what it calls, and how frameworks reach it.
 *
 * Intended to replace a chain of five tool calls with one round trip.
 */
export function explainSymbol(
  store: GraphStore,
  symbol: string,
  opts: ExplainOptions = {}
): SymbolExplanation | null {
  const node = resolveNode(store, symbol);
  if (!node) return null;

  const limit = Math.max(1, opts.limit ?? 50);
  const depth = Math.max(1, opts.maxDepth ?? 1);
  const dynamic = opts.includeDynamic ?? true;

  const decorators = getDecorators(store, node.id, { includeMembers: true });
  const decorated = new Map<string, DecoratorInfo[]>();
  for (const m of decorators?.members ?? []) decorated.set(m.symbol.id, m.decorators);

  const memberRows = store.raw<Row & { edge_props?: string }>(
    `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties, e.properties AS edge_props
     FROM edges e
     JOIN nodes n ON n.id = e.target
     WHERE e.source = ? AND e.kind = 'CONTAINS'
     ORDER BY n.qualified_name
     LIMIT ?`,
    node.id,
    limit
  );

  const propLine = (raw: string): number | undefined => {
    const startLine = parseProps<{ startLine?: number }>(raw).startLine;
    return typeof startLine === "number" ? startLine : undefined;
  };

  const members: ExplainedMember[] = memberRows.map((r) => {
    const line = propLine(r.properties) ?? edgeLine(r.edge_props);
    return {
      symbol: rowToRef(r),
      ...(line !== undefined ? { line } : {}),
      decorators: decorated.get(r.id) ?? [],
    };
  });

  const callers: ImpactCaller[] =
    getCallers(store, node.id, {
      transitive: true,
      maxDepth: depth,
      includeDynamic: dynamic,
      limit,
    })?.callers.map((c) => ({
      caller: c.caller,
      depth: c.depth,
      ...(c.callSiteLine !== undefined ? { callSiteLine: c.callSiteLine } : {}),
      edgeKind: c.edgeKind,
    })) ?? [];

  const callees: ImpactCaller[] =
    getCallees(store, node.id, {
      transitive: true,
      maxDepth: depth,
      includeDynamic: dynamic,
      limit,
    })?.callees.map((c) => ({
      caller: c.callee,
      depth: c.depth,
      ...(c.callSiteLine !== undefined ? { callSiteLine: c.callSiteLine } : {}),
      edgeKind: c.edgeKind,
    })) ?? [];

  const implementations: ImpactImplementation[] = [];
  const typeId =
    node.kind === "method" || node.kind === "constructor" ? enclosingTypeId(node.id) : node.id;
  if (typeId) {
    const impls = findImplementations(store, typeId, { maxDepth: depth, limit });
    const name = memberName(node.id);
    for (const impl of impls?.implementations ?? []) {
      const entry: ImpactImplementation = { type: impl.type, depth: impl.depth, via: impl.via };
      if (name && typeId !== node.id) {
        const override =
          store.getNode(`${impl.type.id}#${name}`) ??
          store.getNodeByQualifiedName(`${impl.type.qualifiedName}#${name}`);
        if (override) entry.method = nodeToRef(override);
      }
      implementations.push(entry);
    }
  }

  const wiringLimit = 200;
  const routes = findRoutes(store, { symbol: node.id, limit: wiringLimit });
  const injections = findInjections(store, { symbol: node.id, limit: wiringLimit });
  const reflections = findReflections(store, { symbol: node.id, limit: wiringLimit });

  const nodeProps = node.properties as { startLine?: number; entryPoint?: boolean };
  const nodeLine = typeof nodeProps.startLine === "number" ? nodeProps.startLine : undefined;

  return {
    symbol: nodeToRef(node),
    ...(nodeLine !== undefined ? { line: nodeLine } : {}),
    ...(nodeProps.entryPoint ? { isEntryPoint: true } : {}),
    decorators: decorators?.decorators ?? [],
    members,
    callers,
    callees,
    implementations,
    routes,
    injections,
    reflections,
    summary: {
      members: members.length,
      callers: callers.length,
      callees: callees.length,
      implementations: implementations.length,
      wiringEdges: routes.length + injections.length + reflections.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

export interface CallCycle {
  size: number;
  members: SymbolRef[];
  /** Shortest closed walk through the cycle, starting at the first member. */
  sample: string[];
}

export interface CycleReport {
  /** Number of multi-node cycles reported (after `minSize`). */
  cycleCount: number;
  cycles: CallCycle[];
  /** Symbols that call themselves directly (size-1 cycles). */
  selfRecursive: SymbolRef[];
  edgeKinds: EdgeKind[];
  scannedNodes: number;
  scannedEdges: number;
  /** True when the edge scan hit `maxNodes` and results may be incomplete. */
  scanTruncated: boolean;
}

export interface CycleOptions {
  edgeKinds?: EdgeKind[];
  includeDynamic?: boolean;
  /** Minimum cycle size to report. Default 2 (direct recursion is separate). */
  minSize?: number;
  /** Cap on edges scanned, guarding against very large graphs. */
  maxEdges?: number;
  limit?: number;
}

/**
 * Find strongly connected components in the call graph with an iterative
 * Tarjan. A component larger than one node means the members are mutually
 * reachable, i.e. a call cycle; a self-edge is direct recursion.
 *
 * Iterative rather than recursive so deep call chains cannot blow the stack.
 */
export function findCycles(store: GraphStore, opts: CycleOptions = {}): CycleReport {
  const edgeKinds =
    opts.edgeKinds && opts.edgeKinds.length > 0
      ? opts.edgeKinds
      : opts.includeDynamic
        ? (["CALLS", "DYNAMIC_DISPATCH"] as EdgeKind[])
        : (["CALLS"] as EdgeKind[]);
  const minSize = Math.max(1, opts.minSize ?? 2);
  const maxEdges = Math.max(1, opts.maxEdges ?? 200000);
  const limit = Math.max(1, opts.limit ?? 100);

  const rows = store.raw<{ source: string; target: string }>(
    `SELECT e.source, e.target
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE e.kind IN (${sqlKinds(edgeKinds)})
       AND s.kind IN ('method', 'constructor')
       AND t.kind IN ('method', 'constructor')
     LIMIT ?`,
    maxEdges
  );
  const scanTruncated = rows.length >= maxEdges;

  const adj = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  const nodes = new Set<string>();
  for (const r of rows) {
    nodes.add(r.source);
    nodes.add(r.target);
    if (r.source === r.target) {
      selfLoops.add(r.source);
      continue;
    }
    const out = adj.get(r.source);
    if (out) out.push(r.target);
    else adj.set(r.source, [r.target]);
  }

  // Iterative Tarjan.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: string; edge: number }[] = [{ node: root, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (!frame) break;
      const { node } = frame;

      if (frame.edge === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }

      const outgoing = adj.get(node) ?? [];
      let descended = false;
      while (frame.edge < outgoing.length) {
        const next = outgoing[frame.edge];
        frame.edge++;
        if (next === undefined) continue;
        if (!index.has(next)) {
          work.push({ node: next, edge: 0 });
          descended = true;
          break;
        }
        if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
        }
      }
      if (descended) continue;

      // Finished exploring `node`.
      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === node) break;
        }
        components.push(component);
      }
      work.pop();

      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(node) ?? 0));
      }
    }
  }

  const refCache = new Map<string, SymbolRef>();
  const refOf = (id: string): SymbolRef | undefined => {
    const cached = refCache.get(id);
    if (cached) return cached;
    const found = store.getNode(id);
    if (!found) return undefined;
    const ref = nodeToRef(found);
    refCache.set(id, ref);
    return ref;
  };

  const cycles: CallCycle[] = [];
  for (const component of components) {
    if (component.length < Math.max(2, minSize)) continue;
    const members = component
      .map(refOf)
      .filter((r): r is SymbolRef => r !== undefined)
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    if (members.length < 2) continue;
    const labels = new Map(members.map((m) => [m.id, m.qualifiedName]));
    cycles.push({
      size: members.length,
      members,
      sample: cycleSample(adj, component, labels),
    });
  }

  const selfRecursive = [...selfLoops]
    .map(refOf)
    .filter((r): r is SymbolRef => r !== undefined)
    .slice(0, limit);

  cycles.sort((a, b) => b.size - a.size);

  return {
    cycleCount: cycles.length,
    cycles: cycles.slice(0, limit),
    selfRecursive,
    edgeKinds,
    scannedNodes: nodes.size,
    scannedEdges: rows.length,
    scanTruncated,
  };
}

/** Walk a closed path inside one component, preferring alphabetical order. */
function cycleSample(
  adj: Map<string, string[]>,
  component: string[],
  labels: Map<string, string>
): string[] {
  const inComponent = new Set(component);
  const start = [...component].sort()[0];
  if (start === undefined) return [];
  const path = [start];
  const seen = new Set([start]);
  let current: string = start;

  for (let step = 0; step < component.length + 1; step++) {
    const candidates = (adj.get(current) ?? []).filter((n) => inComponent.has(n)).sort();
    const next: string | undefined = candidates.find((n) => n === start || !seen.has(n));
    if (next === undefined) break;
    path.push(next);
    if (next === start) {
      return path.map((id) => labels.get(id) ?? id);
    }
    seen.add(next);
    current = next;
  }

  return [...path, start].map((id) => labels.get(id) ?? id);
}

/* ------------------------------------------------------------------ */
/* Diagram export                                                      */
/* ------------------------------------------------------------------ */

export type ExportFormat = "mermaid" | "dot";

export interface GraphExport {
  format: ExportFormat;
  diagram: string;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  /** Symbol the export was centered on, when one was given. */
  center?: SymbolRef;
}

export interface ExportOptions {
  symbol?: string;
  radius?: number;
  edgeKinds?: EdgeKind[];
  format?: ExportFormat;
  direction?: "LR" | "TB" | "RL" | "BT";
  limit?: number;
}

const EXPORT_EDGE_KINDS: EdgeKind[] = [
  "CALLS",
  "DYNAMIC_DISPATCH",
  "ADVISES",
  "ROUTES",
  "INJECTS",
  "REFLECTS",
];

/**
 * Render a neighborhood (or the whole graph) as Mermaid or Graphviz DOT so an
 * agent can show the user a diagram instead of a list of edges.
 */
export function exportGraph(store: GraphStore, opts: ExportOptions = {}): GraphExport | null {
  const format = opts.format ?? "mermaid";
  const direction = opts.direction ?? "LR";
  const limit = Math.max(1, opts.limit ?? 200);
  const edgeKinds =
    opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : EXPORT_EDGE_KINDS;

  let nodes: SymbolRef[];
  let edges: { source: string; target: string; kind: string }[];
  let center: SymbolRef | undefined;

  if (opts.symbol) {
    const sub = getSubgraph(store, opts.symbol, {
      radius: opts.radius ?? 2,
      edgeKinds,
      limit,
    });
    if (!sub.center) return null;
    center = sub.center;
    nodes = sub.nodes;
    edges = sub.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
  } else {
    const rows = store.raw<Row>(
      `SELECT n.id, n.qualified_name, n.kind, n.file_path, n.properties
       FROM nodes n
       WHERE n.kind IN ('class', 'interface', 'method', 'constructor', 'module', 'file', 'aspect')
       ORDER BY n.qualified_name
       LIMIT ?`,
      limit
    );
    nodes = rows.map(rowToRef);
    const ids = new Set(nodes.map((n) => n.id));
    const edgeRows = store.raw<{ source: string; target: string; kind: string }>(
      `SELECT e.source, e.target, e.kind
       FROM edges e
       WHERE e.kind IN (${sqlKinds(edgeKinds)})
       ORDER BY e.source, e.target
       LIMIT ?`,
      limit * 10
    );
    edges = edgeRows.filter((e) => ids.has(e.source) && ids.has(e.target));
  }

  const index = new Map<string, number>();
  const ordered = [...nodes].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  ordered.forEach((n, i) => {
    index.set(n.id, i);
  });

  const seen = new Set<string>();
  const rendered = edges.filter((e) => {
    if (!index.has(e.source) || !index.has(e.target)) return false;
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const label = (n: SymbolRef): string => `${n.qualifiedName}${n.line ? `:${n.line}` : ""}`;
  const safe = (text: string): string => text.replace(/["\\]/g, "\\$&").replace(/\n/g, " ");

  const lines: string[] = [];
  if (format === "mermaid") {
    lines.push(`graph ${direction}`);
    for (const n of ordered) {
      lines.push(`  n${index.get(n.id)}["${safe(label(n))}"]`);
    }
    for (const e of rendered) {
      lines.push(`  n${index.get(e.source)} -->|${e.kind}| n${index.get(e.target)}`);
    }
  } else {
    lines.push("digraph codecrawler {");
    lines.push(`  rankdir=${direction};`);
    for (const n of ordered) {
      lines.push(`  n${index.get(n.id)} [label="${safe(label(n))}", shape=box];`);
    }
    for (const e of rendered) {
      lines.push(`  n${index.get(e.source)} -> n${index.get(e.target)} [label="${e.kind}"];`);
    }
    lines.push("}");
  }

  return {
    format,
    diagram: lines.join("\n"),
    nodeCount: ordered.length,
    edgeCount: rendered.length,
    truncated: nodes.length >= limit,
    ...(center ? { center } : {}),
  };
}
