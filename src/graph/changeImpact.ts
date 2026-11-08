/**
 * Change impact: turn a git diff, a file list or an explicit symbol list into
 * one ranked report of what the change reaches.
 *
 * A single-symbol `impact_analysis` call answers "what breaks if I change
 * this". A reviewer holding a diff needs the same answer for every symbol the
 * diff touches, plus the two wire-ups a call graph cannot show on its own:
 * who injects the changed type, and which advice intercepts the changed
 * method. This module maps changed lines onto declarations and reuses
 * `impactAnalysis` per symbol, so both tools can never drift apart.
 */

import {
  type ImpactCaller,
  type ImpactImplementation,
  type ImpactSummary,
  impactAnalysis,
} from "./insights.js";
import {
  findEventFlows,
  findRoutes,
  nodeToRef,
  resolveNode,
  type SymbolRef,
  type WiringEdge,
} from "./queries.js";
import type { GraphStore } from "./store.js";

/** One 1-based, inclusive line range in the new version of a file. */
export interface DiffRange {
  start: number;
  end: number;
}

export interface DiffFileChange {
  file: string;
  ranges: DiffRange[];
}

/** A declaration that a diff, a file list or a symbol list pointed at. */
export interface ChangedDeclaration {
  symbol: SymbolRef;
  matchedBy: "symbol" | "file" | "diff";
  /** Present for `diff` matches: the hunks that overlapped this declaration. */
  diffRanges?: DiffRange[];
}

export interface InjectionPoint {
  /** `injects`: the changed symbol is injected into `symbol`. */
  role: "injects" | "injectedBy";
  symbol: SymbolRef;
  injectedName?: string;
  framework?: string;
  line?: number;
}

export interface AdvicePoint {
  advice: SymbolRef;
  advised: SymbolRef;
  framework?: string;
  line?: number;
}

export interface ChangedSymbolImpact {
  symbol: SymbolRef;
  matchedBy: ChangedDeclaration["matchedBy"];
  diffRanges?: DiffRange[];
  summary: ImpactSummary & { injectionPoints: number; advice: number };
  /** Ranking score; higher is more exposed. Ordering only, not a probability. */
  score: number;
  callers: ImpactCaller[];
  entryPoints: { symbol: SymbolRef; entryPointKind: string; detail?: string; viaDepth?: number }[];
  routes: WiringEdge[];
  eventFlows: WiringEdge[];
  implementations: ImpactImplementation[];
  injectionPoints: InjectionPoint[];
  advice: AdvicePoint[];
  affectedFiles: string[];
}

export interface ChangeImpactReport {
  /** How the change was described, after normalization. */
  input: { symbols: number; files: string[]; hunks: number };
  symbols: ChangedSymbolImpact[];
  totals: {
    symbols: number;
    callers: number;
    entryPoints: number;
    routes: number;
    injectionPoints: number;
    advice: number;
    eventFlows: number;
    implementations: number;
    affectedFiles: number;
  };
  /** Symbols or files that matched nothing in the index. */
  unmatched: { symbols: string[]; files: string[] };
  /** True when more symbols matched than `maxSymbols` allowed. */
  truncated: boolean;
}

export interface ChangeImpactOptions {
  maxDepth?: number;
  includeDynamic?: boolean;
  /** Callers kept per symbol (default 20). */
  limit?: number;
  /** Symbols ranked in the report (default 25). */
  maxSymbols?: number;
}

/** Declarations a file-level change expands to, before member collapsing. */
const TYPE_KINDS = new Set(["class", "interface", "enum", "annotation_type", "aspect"]);
const MEMBER_KINDS = new Set(["method", "constructor"]);

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Normalize a diff path to the repo-relative, forward-slash form. */
function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^"(.*)"$/, "$1");
  p = p.replace(/\\/g, "/");
  p = p.replace(/^[ab]\//, "");
  p = p.replace(/^\.\//, "");
  return p;
}

/**
 * Extract new-side line ranges per file from unified diff text.
 *
 * Only the new side matters: the index describes the current tree, so a
 * deleted-only hunk is anchored on the line where the deletion happened.
 * Renames are followed to their new path; deletions map to nothing.
 */
export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  const files = new Map<string, DiffFileChange>();
  let current: DiffFileChange | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      const file = normalizePath(target);
      if (!file) {
        current = undefined;
        continue;
      }
      const existing = files.get(file);
      current = existing ?? { file, ranges: [] };
      if (!existing) files.set(file, current);
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (!hunk || !current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // `+start,0` is a pure deletion: nothing on the new side is new, but the
    // deletion happened at this point, so anchor a single line on it.
    current.ranges.push(count === 0 ? { start, end: start } : { start, end: start + count - 1 });
  }

  return [...files.values()].filter((f) => f.ranges.length > 0);
}

interface SpanRow {
  id: string;
  kind: string;
  qualified_name: string;
  name: string | null;
  file_path: string | null;
  properties: string;
}

function spanOf(row: SpanRow): { start: number; end: number } | null {
  const props = JSON.parse(row.properties || "{}") as { startLine?: number; endLine?: number };
  if (typeof props.startLine !== "number") return null;
  // Node lines are zero-based; diff lines are one-based.
  const start = props.startLine + 1;
  const end = typeof props.endLine === "number" ? props.endLine + 1 : start;
  return { start, end: Math.max(start, end) };
}

/**
 * Map a diff path onto indexed file paths.
 *
 * The diff is repository-relative while `file_path` is crawl-root-relative, and
 * the two differ whenever the crawl root is a module of a larger repo. Accept
 * an exact match, else a suffix match on a path boundary in either direction.
 */
function resolveFiles(target: string, known: string[]): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const wanted = norm(target);
  const out: string[] = [];
  for (const candidate of known) {
    const c = norm(candidate);
    if (c === wanted || c.endsWith(`/${wanted}`) || wanted.endsWith(`/${c}`)) {
      out.push(candidate);
    }
  }
  return out;
}

interface DeclarationRow {
  symbol: SymbolRef;
  span: { start: number; end: number };
}

/** Declarations in one file, with their line spans. */
function declarationsIn(store: GraphStore, file: string): DeclarationRow[] {
  const rows = store.raw<SpanRow>(
    `SELECT id, kind, qualified_name, name, file_path, properties
     FROM nodes
     WHERE file_path = ?
       AND kind IN ('class', 'interface', 'enum', 'annotation_type', 'aspect',
                    'method', 'constructor')
     LIMIT 20000`,
    file
  );
  const out: DeclarationRow[] = [];
  for (const row of rows) {
    const span = spanOf(row);
    if (!span) continue;
    out.push({
      symbol: {
        id: row.id,
        qualifiedName: row.qualified_name,
        name: row.name ?? undefined,
        kind: row.kind as SymbolRef["kind"],
        filePath: row.file_path,
      },
      span,
    });
  }
  return out;
}

function enclosingTypeId(id: string): string | undefined {
  const hash = id.lastIndexOf("#");
  return hash > 0 ? id.slice(0, hash) : undefined;
}

/** True when `outer` contains `inner` and is strictly bigger. */
function contains(outer: { start: number; end: number }, inner: { start: number; end: number }) {
  return (
    outer.start <= inner.start &&
    outer.end >= inner.end &&
    outer.end - outer.start > inner.end - inner.start
  );
}

/**
 * Diff-matched declarations, collapsed so a changed method does not also
 * report its enclosing class. A class only survives when nothing smaller in it
 * was touched, which is the case for a field or an annotation change.
 */
function diffDeclarations(
  store: GraphStore,
  changes: DiffFileChange[],
  known: string[],
  unmatched: string[]
): ChangedDeclaration[] {
  const out = new Map<string, ChangedDeclaration>();

  for (const change of changes) {
    const files = resolveFiles(change.file, known);
    if (files.length === 0) {
      unmatched.push(change.file);
      continue;
    }
    for (const file of files) {
      const declared = declarationsIn(store, file);
      const hits = declared.filter((d) =>
        change.ranges.some((r) => d.span.start <= r.end && d.span.end >= r.start)
      );
      for (const hit of hits) {
        // Member wins over its type when both spans were touched.
        if (TYPE_KINDS.has(hit.symbol.kind)) {
          const hasTouchedMember = hits.some(
            (other) =>
              other !== hit &&
              MEMBER_KINDS.has(other.symbol.kind) &&
              contains(hit.span, other.span) &&
              enclosingTypeId(other.symbol.id) === hit.symbol.id
          );
          if (hasTouchedMember) continue;
        }
        const existing = out.get(hit.symbol.id);
        const ranges = change.ranges.filter(
          (r) => hit.span.start <= r.end && hit.span.end >= r.start
        );
        if (existing) {
          existing.diffRanges = [...(existing.diffRanges ?? []), ...ranges];
          continue;
        }
        out.set(hit.symbol.id, {
          symbol: hit.symbol,
          matchedBy: "diff",
          diffRanges: ranges,
        });
      }
    }
  }

  return [...out.values()];
}

/**
 * File-level changes expand to the file's top-level declarations.
 *
 * A module-level Python/TypeScript function is a `method` node owned by the
 * module node, so "top level" is decided by the owner's kind rather than by the
 * declaration's own kind.
 */
function fileDeclarations(
  store: GraphStore,
  files: string[],
  knownPaths: string[],
  unmatched: string[]
): ChangedDeclaration[] {
  const out = new Map<string, ChangedDeclaration>();
  for (const wanted of files) {
    const matched = resolveFiles(normalizePath(wanted), knownPaths);
    if (matched.length === 0) {
      unmatched.push(wanted);
      continue;
    }
    for (const file of matched) {
      for (const decl of declarationsIn(store, file)) {
        if (TYPE_KINDS.has(decl.symbol.kind)) {
          out.set(decl.symbol.id, { symbol: decl.symbol, matchedBy: "file" });
          continue;
        }
        if (decl.symbol.kind !== "method") continue;
        const owner = enclosingTypeId(decl.symbol.id);
        if (!owner) continue;
        if (store.getNode(owner)?.kind === "module") {
          out.set(decl.symbol.id, { symbol: decl.symbol, matchedBy: "file" });
        }
      }
    }
  }
  return [...out.values()];
}

function injectionsFor(store: GraphStore, id: string): InjectionPoint[] {
  const rows = store.raw<{ source: string; target: string; properties: string }>(
    `SELECT source, target, properties FROM edges
     WHERE kind = 'INJECTS' AND (source = ? OR target = ?)
     LIMIT 500`,
    id,
    id
  );
  const out: InjectionPoint[] = [];
  for (const row of rows) {
    const otherId = row.source === id ? row.target : row.source;
    if (otherId === id) continue;
    const other = store.getNode(otherId);
    if (!other) continue;
    const props = JSON.parse(row.properties || "{}") as {
      injectedName?: string;
      framework?: string;
      line?: number;
    };
    out.push({
      role: row.source === id ? "injects" : "injectedBy",
      symbol: nodeToRef(other),
      ...(props.injectedName ? { injectedName: props.injectedName } : {}),
      ...(props.framework ? { framework: props.framework } : {}),
      ...(props.line !== undefined ? { line: props.line } : {}),
    });
  }
  return out.sort((a, b) => a.role.localeCompare(b.role) || a.symbol.id.localeCompare(b.symbol.id));
}

function adviceFor(store: GraphStore, id: string, isType: boolean): AdvicePoint[] {
  // ADVISES runs advice -> advised, so a changed method is advised when it is
  // the target. For a type, every member is checked through CONTAINS.
  const rows = isType
    ? store.raw<{ source: string; target: string; properties: string }>(
        `SELECT a.source, a.target, a.properties
         FROM edges a
         JOIN edges c ON c.target = a.target AND c.kind = 'CONTAINS' AND c.source = ?
         WHERE a.kind = 'ADVISES'
         LIMIT 500`,
        id
      )
    : store.raw<{ source: string; target: string; properties: string }>(
        `SELECT source, target, properties FROM edges
         WHERE kind = 'ADVISES' AND target = ?
         LIMIT 500`,
        id
      );

  const out: AdvicePoint[] = [];
  for (const row of rows) {
    const advice = store.getNode(row.source);
    const advised = store.getNode(row.target);
    if (!advice || !advised) continue;
    const props = JSON.parse(row.properties || "{}") as {
      framework?: string;
      line?: number;
    };
    out.push({
      advice: nodeToRef(advice),
      advised: nodeToRef(advised),
      ...(props.framework ? { framework: props.framework } : {}),
      ...(props.line !== undefined ? { line: props.line } : {}),
    });
  }
  return out.sort((a, b) => a.advice.id.localeCompare(b.advice.id));
}

function riskScore(risk: ImpactSummary["risk"]): number {
  return risk === "high" ? 1000 : risk === "medium" ? 100 : 0;
}

const wiringKey = (e: WiringEdge) => `${e.source.id}->${e.target.id}:${e.path ?? ""}`;

/**
 * Extend `impactAnalysis`'s wiring to everything the change reaches.
 *
 * `impactAnalysis` keeps only the routes and event flows wired straight to the
 * analysed symbol or its members, which is the right answer for "what is wired
 * to this method". A change is broader than that: editing a service must still
 * name the endpoint that reaches it through a handler. So anything whose
 * wired endpoint is the symbol or one of its transitive callers is added.
 */
function reachableWiring(
  direct: WiringEdge[],
  all: WiringEdge[],
  reachable: Set<string>,
  side: "source" | "target"
): WiringEdge[] {
  const seen = new Set(direct.map(wiringKey));
  const out = [...direct];
  for (const edge of all) {
    if (!reachable.has(edge[side].id)) continue;
    const key = wiringKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/**
 * Score orders the report; it is never a probability. Framework reach dominates
 * because an entry point makes a change externally visible, then wire-ups that
 * a static call graph cannot show.
 */
function scoreOf(entry: {
  summary: ImpactSummary;
  routes: unknown[];
  eventFlows: unknown[];
  injectionPoints: InjectionPoint[];
  advice: AdvicePoint[];
}): number {
  return (
    riskScore(entry.summary.risk) +
    20 * entry.summary.routes +
    20 * entry.summary.entryPoints +
    10 * entry.injectionPoints.length +
    10 * entry.advice.length +
    5 * entry.eventFlows.length +
    entry.summary.totalCallers
  );
}

/**
 * "What does this diff break?" — every symbol the change touches, ranked.
 *
 * Supply any combination of `symbols`, `files` and `diff`. Files and diff hunks
 * are mapped onto declarations by line span; a changed member replaces its
 * enclosing type so the report does not count the same call sites twice.
 */
export function changeImpact(
  store: GraphStore,
  query: { symbols?: string[]; files?: string[]; diff?: string },
  opts: ChangeImpactOptions = {}
): ChangeImpactReport {
  const limit = Math.max(1, opts.limit ?? 20);
  const maxSymbols = Math.max(1, opts.maxSymbols ?? 25);
  const knownPaths = store
    .raw<{ file_path: string | null }>(
      "SELECT DISTINCT file_path FROM nodes WHERE file_path IS NOT NULL LIMIT 50000"
    )
    .map((r) => r.file_path)
    .filter((p): p is string => typeof p === "string");

  const unmatched = { symbols: [] as string[], files: [] as string[] };
  const found = new Map<string, ChangedDeclaration>();

  for (const requested of query.symbols ?? []) {
    const node = resolveNode(store, requested);
    if (!node) {
      unmatched.symbols.push(requested);
      continue;
    }
    const decl: ChangedDeclaration = { symbol: nodeToRef(node), matchedBy: "symbol" };
    found.set(node.id, decl);
  }

  if (query.files && query.files.length > 0) {
    for (const decl of fileDeclarations(store, query.files, knownPaths, unmatched.files)) {
      found.set(decl.symbol.id, decl);
    }
  }

  const changes = query.diff ? parseUnifiedDiff(query.diff) : [];
  if (changes.length > 0) {
    for (const decl of diffDeclarations(store, changes, knownPaths, unmatched.files)) {
      found.set(decl.symbol.id, decl);
    }
  }

  const allRoutes = findRoutes(store, { limit: 10000 });
  const allFlows = findEventFlows(store, { limit: 10000 });

  const analysed: ChangedSymbolImpact[] = [];
  for (const decl of found.values()) {
    const impact = impactAnalysis(store, decl.symbol.id, {
      maxDepth: opts.maxDepth,
      includeDynamic: opts.includeDynamic,
      limit,
    });
    if (!impact) continue;
    const isType = TYPE_KINDS.has(decl.symbol.kind) || decl.symbol.kind === "module";
    const injectionPoints = injectionsFor(store, decl.symbol.id);
    const advice = adviceFor(store, decl.symbol.id, isType);
    const reachable = new Set<string>([decl.symbol.id]);
    for (const c of impact.callers) reachable.add(c.caller.id);
    const routes = reachableWiring(impact.routes, allRoutes, reachable, "target");
    const eventFlows = reachableWiring(impact.eventFlows, allFlows, reachable, "source");
    const summary = {
      ...impact.summary,
      routes: routes.length,
      eventFlows: eventFlows.length,
      injectionPoints: injectionPoints.length,
      advice: advice.length,
    };
    analysed.push({
      symbol: decl.symbol,
      matchedBy: decl.matchedBy,
      ...(decl.diffRanges ? { diffRanges: decl.diffRanges } : {}),
      summary,
      score: scoreOf({
        summary,
        routes,
        eventFlows,
        injectionPoints,
        advice,
      }),
      callers: impact.callers,
      entryPoints: impact.entryPoints,
      routes,
      eventFlows,
      implementations: impact.implementations,
      injectionPoints,
      advice,
      affectedFiles: impact.affectedFiles,
    });
  }

  analysed.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id));

  const kept = analysed.slice(0, maxSymbols);
  const files = new Set<string>();
  const callerIds = new Set<string>();
  const routeKeys = new Set<string>();
  const entryKeys = new Set<string>();
  const injectionKeys = new Set<string>();
  const adviceKeys = new Set<string>();
  const flowKeys = new Set<string>();
  const implKeys = new Set<string>();
  for (const entry of kept) {
    for (const f of entry.affectedFiles) files.add(f);
    for (const c of entry.callers) callerIds.add(c.caller.id);
    for (const r of entry.routes) routeKeys.add(`${r.source.id}->${r.target.id}:${r.path ?? ""}`);
    for (const e of entry.entryPoints) entryKeys.add(e.symbol.id);
    for (const i of entry.injectionPoints) injectionKeys.add(`${i.role}:${i.symbol.id}`);
    for (const a of entry.advice) adviceKeys.add(`${a.advice.id}->${a.advised.id}`);
    for (const f of entry.eventFlows) flowKeys.add(`${f.source.id}->${f.target.id}`);
    for (const i of entry.implementations) implKeys.add(i.type.id);
  }

  return {
    input: {
      symbols: (query.symbols ?? []).length,
      files: (query.files ?? []).map(normalizePath),
      hunks: changes.reduce((sum, c) => sum + c.ranges.length, 0),
    },
    symbols: kept,
    totals: {
      symbols: kept.length,
      callers: callerIds.size,
      entryPoints: entryKeys.size,
      routes: routeKeys.size,
      injectionPoints: injectionKeys.size,
      advice: adviceKeys.size,
      eventFlows: flowKeys.size,
      implementations: implKeys.size,
      affectedFiles: files.size,
    },
    unmatched,
    truncated: analysed.length > kept.length,
  };
}
