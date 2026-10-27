import fs from "node:fs";
import path from "node:path";
import type { GraphStore } from "./graph/store.js";
import type { GraphEdge, GraphNode, NodeKind } from "./graph/schema.js";
import { annotationNodeId, fieldNodeId, importNodeId } from "./graph/schema.js";
import { languageForFile } from "./parser/languages/index.js";
import type { AnnotationInfo, ParsedFile } from "./parser/language.js";
import { buildTypeIndex, phantomNodeId } from "./resolver/types.js";
import { resolveJavaFile } from "./resolver/javaResolver.js";
import { buildDynamicEdges, isDecoratorAnnotation } from "./resolver/dynamic.js";
import type { JavaParsedFile } from "./parser/languages/java.js";

/**
 * Project crawler: discover source files, parse them, build a global type
 * index, resolve call targets, and persist an idempotent file-scoped graph.
 */

export interface CrawlOptions {
  /** Force a specific language regardless of extension. */
  language?: string;
  /** Optional include filter: path must contain this substring. */
  fileFilter?: string;
}

export interface CrawlResult {
  projectPath: string;
  filesScanned: number;
  filesParsed: number;
  filesRemoved: number;
  nodes: number;
  edges: number;
  resolvedCalls: number;
  unresolvedCalls: number;
  /** Virtual-dispatch edges discovered across the project. */
  dynamicDispatchEdges: number;
  /** Aspect advice -> advised-method edges. */
  adviceEdges: number;
  /** Number of aspect types that produced advice. */
  aspects: number;
  /** Number of annotation/decorator usages indexed. */
  decorators: number;
  languages: string[];
  durationMs: number;
}

/** Discover source files under a project, respecting exclusion dirs. */
export function discoverSourceFiles(
  projectPath: string,
  excludeDirs: string[],
  language?: string
): string[] {
  const excluded = new Set(excludeDirs.map((d) => d.replace(/\/+$/, "")));
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions) — skip
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) walk(full);
      } else if (entry.isFile() && languageForFile(entry.name, language)) {
        out.push(full);
      }
    }
  }

  walk(projectPath);
  return out.sort();
}

/** Convert a ParsedFile into graph nodes + edges (declarations only). */
export function buildDeclarationGraph(parsed: ParsedFile): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileId = parsed.filePath;
  const fileLines = sourceLineCount(parsed.filePath);
  nodes.push({
    id: fileId,
    kind: "file",
    qualifiedName: fileId,
    filePath: fileId,
    properties: { language: parsed.language, startLine: 0, endLine: fileLines },
  });

  if (parsed.packageName) {
    // Package nodes are shared by every file in the package. They are not
    // owned by one file (filePath: null) so deleting one file cannot cascade
    // through the package node into unrelated files.
    nodes.push({
      id: parsed.packageName,
      kind: "package",
      qualifiedName: parsed.packageName,
      filePath: null,
      properties: {},
    });
    edges.push({
      source: fileId,
      target: parsed.packageName,
      kind: "DECLARED_IN",
      properties: {},
    });
  }

  for (const imp of parsed.imports) {
    const importId = importNodeId(imp.fqn);
    nodes.push({
      id: importId,
      kind: "import",
      qualifiedName: imp.fqn,
      filePath: fileId,
      properties: { simpleName: imp.simpleName, static: imp.isStatic },
    });
    edges.push({ source: fileId, target: importId, kind: "IMPORTS", properties: {} });
  }

  const addDecorators = (ownerId: string, annotations: AnnotationInfo[]): void => {
    for (const annotation of annotations) {
      const name = annotation.fqn ?? annotation.name;
      const id = annotationNodeId(name);
      // Annotation nodes are shared across files and therefore file-less.
      nodes.push({
        id,
        kind: "annotation",
        qualifiedName: name,
        filePath: null,
        properties: {
          name: annotation.name,
          ...(annotation.fqn ? { fqn: annotation.fqn } : {}),
          decorator: isDecoratorAnnotation(annotation.name),
        },
      });
      edges.push({
        source: ownerId,
        target: id,
        kind: "ANNOTATED_WITH",
        properties: {
          line: annotation.line,
          arguments: annotation.arguments,
        },
      });
    }
  };

  for (const t of parsed.types) {
    const kind: NodeKind = t.isAspect
      ? "aspect"
      : t.kind === "annotation"
        ? "annotation_type"
        : t.kind;
    nodes.push({
      id: t.id,
      kind,
      qualifiedName: t.id,
      filePath: fileId,
      properties: {
        name: t.name,
        startLine: t.startLine,
        endLine: t.endLine,
        annotations: t.annotations.map((a) => a.name),
        ...(t.isAspect ? { aspect: true } : {}),
      },
    });
    edges.push({ source: fileId, target: t.id, kind: "CONTAINS", properties: {} });
    if (parsed.packageName) {
      edges.push({ source: t.id, target: parsed.packageName, kind: "DECLARED_IN", properties: {} });
    }
    for (const parent of t.extendsTypes) {
      edges.push({ source: t.id, target: parent, kind: "EXTENDS", properties: {} });
    }
    for (const parent of t.implementsTypes) {
      edges.push({ source: t.id, target: parent, kind: "IMPLEMENTS", properties: {} });
    }
    addDecorators(t.id, t.annotations);
  }

  for (const m of parsed.methods) {
    nodes.push({
      id: m.id,
      kind: m.isConstructor ? "constructor" : "method",
      qualifiedName: m.id,
      filePath: fileId,
      properties: {
        name: m.name,
        signature: `(${m.params.map((p) => p.type).join(", ")})`,
        returnType: m.returnType,
        modifiers: m.modifiers,
        startLine: m.startLine,
        endLine: m.endLine,
        annotations: m.annotations.map((a) => a.name),
        ...(m.adviceKind ? { adviceKind: m.adviceKind } : {}),
        ...(m.pointcut ? { pointcut: m.pointcut } : {}),
      },
    });
    edges.push({
      source: m.typeId,
      target: m.id,
      kind: "CONTAINS",
      properties: { line: m.startLine },
    });
    addDecorators(m.id, m.annotations);
  }

  for (const f of parsed.fields) {
    nodes.push({
      id: fieldNodeId(f.typeId, f.name),
      kind: "field",
      qualifiedName: f.id,
      filePath: fileId,
      properties: {
        name: f.name,
        type: f.type,
        startLine: f.startLine,
        annotations: f.annotations.map((a) => a.name),
      },
    });
    edges.push({
      source: f.typeId,
      target: fieldNodeId(f.typeId, f.name),
      kind: "CONTAINS",
      properties: { line: f.startLine },
    });
    addDecorators(fieldNodeId(f.typeId, f.name), f.annotations);
  }

  return { nodes: dedupeById(nodes), edges: dedupeEdges(edges) };
}

function dedupeById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve call sites for a parsed file into CALLS edges + phantom nodes. */
export function buildCallEdges(
  parsed: ParsedFile,
  index: ReturnType<typeof buildTypeIndex>,
  knownNodeIds: Set<string>
): { edges: GraphEdge[]; phantomNodes: GraphNode[]; resolved: number; unresolved: number } {
  const edges: GraphEdge[] = [];
  const phantomNodes: GraphNode[] = [];
  let resolved = 0;
  let unresolved = 0;

  const javaParsed = parsed as JavaParsedFile;
  const resolvedCalls =
    parsed.language === "java" ? resolveJavaFile(javaParsed, index) : [];

  for (const rc of resolvedCalls) {
    // Calls in field/static initializers have no enclosing method; attribute
    // them to the enclosing type so the edge always has a valid source.
    const source = rc.callSite.enclosingMethodId || rc.callSite.enclosingTypeId;
    if (rc.resolved) {
      resolved++;
      // Targets can reference synthetic methods (e.g. implicit default
      // constructors) that are not declared anywhere; create a node for them.
      if (!knownNodeIds.has(rc.targetId)) {
        const synthetic: GraphNode = {
          id: rc.targetId,
          kind: rc.targetId.endsWith("#<init>") ? "constructor" : "method",
          qualifiedName: rc.targetId,
          filePath: parsed.filePath,
          properties: {
            name: rc.targetId.includes("#") ? rc.targetId.split("#").pop() ?? "" : rc.targetId,
            synthetic: true,
            reason: rc.reason,
          },
        };
        phantomNodes.push(synthetic);
        knownNodeIds.add(rc.targetId);
      }
      edges.push({
        source,
        target: rc.targetId,
        kind: "CALLS",
        properties: {
          line: rc.callSite.line,
          resolved: true,
          confidence: Math.round(rc.confidence * 100) / 100,
          reason: rc.reason,
        },
      });
    } else {
      unresolved++;
      const phantomId = phantomNodeId(rc.callSite);
      phantomNodes.push({
        id: phantomId,
        kind: "unknown_symbol",
        qualifiedName: phantomId,
        filePath: parsed.filePath,
        properties: {
          name: rc.callSite.isConstructorCall ? rc.callSite.name : `${rc.callSite.receiver ? `${rc.callSite.receiver}.` : ""}${rc.callSite.name}`,
          reason: rc.reason,
        },
      });
      edges.push({
        source,
        target: phantomId,
        kind: "CALLS",
        properties: {
          line: rc.callSite.line,
          resolved: false,
          confidence: 0,
          reason: rc.reason,
        },
      });
    }
  }

  return { edges, phantomNodes, resolved, unresolved };
}

/**
 * Crawl a project directory and index it into the store.
 * Idempotent: re-crawling refreshes the graph; files that disappeared are
 * removed from the index.
 */
export async function crawlProject(
  store: GraphStore,
  projectPath: string,
  excludeDirs: string[],
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const started = Date.now();
  const absPath = path.resolve(projectPath);

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    throw new Error(`project path is not a directory: ${projectPath}`);
  }

  const files = discoverSourceFiles(absPath, excludeDirs, options.language);
  if (options.fileFilter) {
    const filter = options.fileFilter;
    files.splice(
      0,
      files.length,
      ...files.filter((f) => f.includes(filter))
    );
  }

  // Parse every file (grammar is cached, so subsequent parses are fast).
  const parsedFiles: ParsedFile[] = [];
  const parseErrors: string[] = [];
  for (const file of files) {
    try {
      const source = fs.readFileSync(file, "utf8");
      const config = languageForFile(file, options.language);
      if (!config) continue;
      parsedFiles.push(await config.parseFile(source, file));
    } catch (err) {
      parseErrors.push(`${file}: ${(err as Error).message}`);
    }
  }

  // Global index for cross-file resolution.
  const index = buildTypeIndex(parsedFiles);

  // Build nodes + edges per file and persist file-scoped.
  const previouslyIndexed = new Set(
    (store.raw("SELECT DISTINCT file_path FROM nodes WHERE file_path IS NOT NULL") as { file_path: string }[]).map(
      (r) => r.file_path
    )
  );
  const currentFiles = new Set(files);
  let filesRemoved = 0;
  let totalResolved = 0;
  let totalUnresolved = 0;
  let totalDecorators = 0;
  let dynamicDispatchCount = 0;
  let adviceCount = 0;
  let aspectCount = 0;

  // Every resolved call edge across the project, used to derive virtual
  // dispatch edges once the whole type hierarchy is known.
  const allCallEdges: GraphEdge[] = [];

  // Pre-compute every declared node id so synthetic targets (default
  // constructors) can be created on demand, and so EXTENDS/IMPLEMENTS edges
  // to external types can be dropped instead of violating FK constraints.
  const allNodeIds = new Set<string>();
  const declarations = new Map<string, ReturnType<typeof buildDeclarationGraph>>();
  for (const parsed of parsedFiles) {
    const decl = buildDeclarationGraph(parsed);
    declarations.set(parsed.filePath, decl);
    for (const n of decl.nodes) allNodeIds.add(n.id);
  }

  // Hierarchy metadata is emitted with whatever name the source used
  // (`implements Payment`), which is not always the fully-qualified node id.
  // Resolve unique simple names so EXTENDS/IMPLEMENTS edges survive the
  // project-membership filter below.
  const typeIdsByName = new Map<string, string[]>();
  for (const parsed of parsedFiles) {
    for (const t of parsed.types) {
      const ids = typeIdsByName.get(t.name) ?? [];
      if (!ids.includes(t.id)) ids.push(t.id);
      typeIdsByName.set(t.name, ids);
    }
  }
  const normalizeHierarchyTarget = (edge: GraphEdge): GraphEdge => {
    if (edge.kind !== "EXTENDS" && edge.kind !== "IMPLEMENTS") return edge;
    if (allNodeIds.has(edge.target)) return edge;
    const candidates = typeIdsByName.get(edge.target);
    const resolved = candidates?.length === 1 ? candidates[0] : undefined;
    return resolved ? { ...edge, target: resolved } : edge;
  };

  store.withTransaction(() => {
    for (const parsed of parsedFiles) {
      const decl = declarations.get(parsed.filePath)!;
      const calls = buildCallEdges(parsed, index, allNodeIds);

      for (const p of calls.phantomNodes) allNodeIds.add(p.id);

      // Phantom nodes must exist as edge endpoints (FK constraint).
      for (const p of calls.phantomNodes) store.ensureNode(p);

      // Drop edges whose endpoints aren't part of the indexed project
      // (external EXTENDS/IMPLEMENTS/IMPORTS targets).
      const edges = decl.edges
        .map(normalizeHierarchyTarget)
        .concat(calls.edges)
        .filter((e) => allNodeIds.has(e.source) && allNodeIds.has(e.target));
      const nodes = decl.nodes.concat(calls.phantomNodes);
      store.replaceFile(parsed.filePath, nodes, edges);

      for (const edge of calls.edges) {
        if (allNodeIds.has(edge.source) && allNodeIds.has(edge.target)) {
          allCallEdges.push(edge);
        }
      }

      totalDecorators += decl.edges.filter(
        (e) => e.kind === "ANNOTATED_WITH" && isDecoratorAnnotation(e.target.slice(1))
      ).length;
      totalResolved += calls.resolved;
      totalUnresolved += calls.unresolved;
      previouslyIndexed.delete(parsed.filePath);
    }

    // Remove files that disappeared from the project.
    for (const stale of previouslyIndexed) {
      if (!currentFiles.has(stale)) {
        store.removeFile(stale);
        filesRemoved++;
      }
    }

    // Rebuild project-wide derived edges: virtual dispatch and AOP advice.
    store.deleteEdgesByKind(["DYNAMIC_DISPATCH", "ADVISES"]);
    const dynamic = buildDynamicEdges(parsedFiles, index, allNodeIds, allCallEdges);
    store.upsertEdges(dynamic.edges);
    dynamicDispatchCount = dynamic.dispatchCount;
    adviceCount = dynamic.adviceCount;
    aspectCount = dynamic.aspects;
  });

  store.setMeta("last_crawl_at", new Date().toISOString());
  store.setMeta("last_project_path", absPath);

  const stats = store.stats();
  return {
    projectPath: absPath,
    filesScanned: files.length,
    filesParsed: parsedFiles.length,
    filesRemoved,
    nodes: stats.nodes,
    edges: stats.edges,
    resolvedCalls: totalResolved,
    unresolvedCalls: totalUnresolved,
    dynamicDispatchEdges: dynamicDispatchCount,
    adviceEdges: adviceCount,
    aspects: aspectCount,
    decorators: totalDecorators,
    languages: [...new Set(parsedFiles.map((p) => p.language))],
    durationMs: Date.now() - started,
  };
}

function sourceLineCount(filePath: string): number {
  try {
    return fs.readFileSync(filePath, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}
