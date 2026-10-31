import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import type { GraphEdge, GraphNode, NodeKind } from "./graph/schema.js";
import { annotationNodeId, externalNodeId, fieldNodeId, importNodeId } from "./graph/schema.js";
import type { FileRecord, GraphStore } from "./graph/store.js";
import { decodeParsedFile, encodeParsedFile } from "./parser/cache.js";
import type { AnnotationInfo, EntryPointInfo, ParsedFile } from "./parser/language.js";
import { getLanguageConfig, languageForFile } from "./parser/languages/index.js";
import { isConstructorMethodId, ownerTypeOfMethodId } from "./parser/methodId.js";
import { normalizeTypeText, resolveTypeCandidates } from "./resolver/common.js";
import { buildDynamicEdges, isDecoratorAnnotation } from "./resolver/dynamic.js";
import {
  resolveInjectionTarget,
  resolveReflectiveTarget,
  resolveRouteHandler,
} from "./resolver/genericResolver.js";
import { DEFAULT_RESOLVER, resolveFileWith } from "./resolver/registry.js";
import { buildTypeIndex, phantomNodeId } from "./resolver/types.js";

/**
 * Project crawler: discover source files, parse them, build a global type
 * index, resolve call targets, and persist an idempotent file-scoped graph.
 */

export interface CrawlOptions {
  /** Force a specific language regardless of extension. */
  language?: string;
  /** Optional include filter: path must contain this substring. */
  fileFilter?: string;
  /** Honor the project's .gitignore (default true). */
  respectGitignore?: boolean;
  /** Skip files larger than this many bytes. */
  maxFileBytes?: number;
  /**
   * Re-parse every discovered file, ignoring the manifest's size, mtime and
   * content-hash shortcuts.
   *
   * Freshness is metadata-based, so a same-size edit with a restored mtime —
   * what `git checkout`, `rsync -t`, unzip, or a clock skew leaves behind — is
   * otherwise indistinguishable from an untouched file and the stale parse is
   * replayed. This is the escape hatch for that case.
   */
  force?: boolean;
  /** Called as parsing/persisting advances, for progress reporting. */
  onProgress?: (progress: CrawlProgress) => void;
}

export interface CrawlProgress {
  phase: "parse" | "persist";
  processed: number;
  total: number;
}

/** A discovered file that was deliberately not parsed. */
export interface SkippedFile {
  path: string;
  reason: "too-large" | "binary";
}

export interface CrawlResult {
  projectPath: string;
  filesScanned: number;
  /** Files whose parse result is in the index after this crawl. */
  filesParsed: number;
  /** Files parsed for the first time by this crawl. */
  filesAdded: number;
  /** Files re-parsed because their content changed (or because the crawl was forced). */
  filesUpdated: number;
  /** Files replayed from the parse cache because their content was identical. */
  filesUnchanged: number;
  filesRemoved: number;
  /** Files skipped because they are too large or look binary. */
  filesSkipped: number;
  skippedFiles: SkippedFile[];
  /** Per-file parse failures (paths and messages, capped for output size). */
  parseErrors: string[];
  /** False when the crawl was scoped (fileFilter/language) and stale pruning was skipped. */
  pruned: boolean;
  /** File-less shared nodes deleted because nothing references them anymore. */
  orphansRemoved: number;
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
  /** Framework-invoked roots (routes, listeners, schedulers, CLI, tests). */
  entryPoints: number;
  /** Framework-supplied dependency edges. */
  injections: number;
  /** Run-time lookup edges (reflection, dynamic import, getattr). */
  reflections: number;
  /** Distinct external packages/specifiers referenced by the project. */
  externalDependencies: number;
  /** Route registrations mapped to handler methods. */
  routes: number;
  languages: string[];
  durationMs: number;
}

export interface DiscoverOptions {
  language?: string;
  /** Honor the project's .gitignore (default true). */
  respectGitignore?: boolean;
}

/** Optional project-local crawl configuration. */
const CRAWLER_RC = ".crawlerrc";

interface CrawlerRc {
  include?: string[];
  exclude?: string[];
}

function loadCrawlerRc(projectPath: string): CrawlerRc {
  const file = path.join(projectPath, CRAWLER_RC);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const strings = (value: unknown, field: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new Error(`"${field}" must be an array of strings`);
      }
      return value as string[];
    };
    return {
      include: strings(record.include, "include"),
      exclude: strings(record.exclude, "exclude"),
    };
  } catch (err) {
    process.stderr.write(`code-crawler: ignoring ${CRAWLER_RC}: ${(err as Error).message}\n`);
    return {};
  }
}

/**
 * Discover source files under a project.
 *
 * Honors the hardcoded/configured exclusion directory names, the project's
 * `.gitignore`, and an optional `.crawlerrc` with gitignore-style `include`
 * and `exclude` globs. When `include` is present only matching files are
 * indexed.
 */
export function discoverSourceFiles(
  projectPath: string,
  excludeDirs: string[],
  options: string | DiscoverOptions = {}
): string[] {
  const opts: DiscoverOptions = typeof options === "string" ? { language: options } : options;
  const excluded = new Set(excludeDirs.map((d) => d.replace(/\/+$/, "")));

  const rc = loadCrawlerRc(projectPath);
  const excludeMatcher = ignore().add(rc.exclude ?? []);
  const includeMatcher = ignore().add(rc.include ?? []);
  const hasIncludes = (rc.include?.length ?? 0) > 0;

  if (opts.respectGitignore !== false) {
    try {
      const gitignorePath = path.join(projectPath, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        excludeMatcher.add(fs.readFileSync(gitignorePath, "utf8"));
      }
    } catch {
      // Unreadable .gitignore: fall back to indexing everything.
    }
  }

  const ignored = (rel: string, isDir: boolean): boolean => {
    const candidate = isDir ? `${rel}/` : rel;
    if (excludeMatcher.ignores(candidate)) return true;
    if (hasIncludes && !includeMatcher.ignores(candidate)) return true;
    return false;
  };

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
      const rel = path.relative(projectPath, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (excluded.has(entry.name) || ignored(rel, true)) continue;
        walk(full);
      } else if (
        entry.isFile() &&
        languageForFile(entry.name, opts.language) &&
        !ignored(rel, false)
      ) {
        out.push(full);
      }
    }
  }

  walk(projectPath);
  return out.sort();
}

/** Convert a ParsedFile into graph nodes + edges (declarations only). */
export function buildDeclarationGraph(parsed: ParsedFile): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileId = parsed.filePath;
  const fileLines = parsed.lineCount ?? sourceLineCount(parsed.filePath);
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
        ...(t.isRecord ? { record: true } : {}),
        ...(t.exported === false ? { exported: false } : {}),
        ...(t.kind === "module" && parsed.entryPoint
          ? {
              entryPoint: true,
              entryPointKind: parsed.entryPoint.kind,
              entryPointDetail: parsed.entryPoint.detail ?? parsed.entryPoint.kind,
            }
          : {}),
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
        ...(m.entryPoint
          ? {
              entryPoint: true,
              entryPointKind: m.entryPoint.kind,
              entryPointDetail: m.entryPoint.detail ?? m.entryPoint.kind,
            }
          : {}),
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
): {
  edges: GraphEdge[];
  phantomNodes: GraphNode[];
  resolved: number;
  unresolved: number;
  external: number;
  externalPackages: Set<string>;
} {
  const edges: GraphEdge[] = [];
  const phantomNodes: GraphNode[] = [];
  const externalPackages = new Set<string>();
  let resolved = 0;
  let unresolved = 0;
  let external = 0;

  const resolvedCalls = resolveFileWith(
    getLanguageConfig(parsed.language)?.resolver ?? DEFAULT_RESOLVER,
    parsed,
    index
  );

  for (const rc of resolvedCalls) {
    // Calls in field/static initializers have no enclosing method; attribute
    // them to the enclosing type so the edge always has a valid source.
    const source = rc.callSite.enclosingMethodId || rc.callSite.enclosingTypeId;
    const flowProps = rc.callSite.controlFlow
      ? {
          conditional:
            rc.callSite.controlFlow.kinds.includes("branch") ||
            rc.callSite.controlFlow.kinds.includes("exception"),
          ...(rc.callSite.controlFlow.guards.length > 0
            ? { guards: rc.callSite.controlFlow.guards }
            : {}),
        }
      : {};
    const flowKind = rc.callSite.controlFlow ? { controlFlow: rc.callSite.controlFlow.kinds } : {};

    if (rc.external) {
      external++;
      const pkg = rc.externalModule ?? "unknown";
      externalPackages.add(pkg);
      const extId = externalNodeId(pkg);
      if (!knownNodeIds.has(extId)) {
        phantomNodes.push({
          id: extId,
          kind: "external_symbol",
          qualifiedName: extId,
          filePath: null,
          properties: { name: pkg, package: pkg, external: true },
        });
        knownNodeIds.add(extId);
      }
    }

    if (rc.resolved) {
      resolved++;
      // Targets can reference synthetic methods (e.g. implicit default
      // constructors) that are not declared anywhere; create a node for them.
      if (!knownNodeIds.has(rc.targetId)) {
        const synthetic: GraphNode = {
          id: rc.targetId,
          kind: isConstructorMethodId(rc.targetId) ? "constructor" : "method",
          qualifiedName: rc.targetId,
          filePath: parsed.filePath,
          properties: {
            name: rc.targetId.includes("#") ? (rc.targetId.split("#").pop() ?? "") : rc.targetId,
            synthetic: true,
            reason: rc.reason,
          },
        };
        phantomNodes.push(synthetic);
        knownNodeIds.add(rc.targetId);
        // An implicit constructor has no declaration to hang a CONTAINS edge on,
        // so attach one here. Without it the type's own constructor is not
        // reachable from the type when the graph is traversed.
        if (isConstructorMethodId(rc.targetId)) {
          const ownerType = ownerTypeOfMethodId(rc.targetId);
          if (knownNodeIds.has(ownerType)) {
            edges.push({
              source: ownerType,
              target: rc.targetId,
              kind: "CONTAINS",
              properties: { line: rc.callSite.line, synthetic: true },
            });
          }
        }
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
          ...flowProps,
          ...flowKind,
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
          name: rc.callSite.isConstructorCall
            ? rc.callSite.name
            : `${rc.callSite.receiver ? `${rc.callSite.receiver}.` : ""}${rc.callSite.name}`,
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
          ...flowProps,
          ...flowKind,
        },
      });
    }
  }

  return { edges, phantomNodes, resolved, unresolved, external, externalPackages };
}

/**
 * Framework wiring that the language parsers surface but the plain call
 * resolver cannot see: external dependencies, dependency injection,
 * reflective lookups and route registrations.
 */
export function buildDependencyGraph(
  parsed: ParsedFile,
  index: ReturnType<typeof buildTypeIndex>,
  knownNodeIds: Set<string>
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryPointMarks: Map<string, EntryPointInfo>;
  injections: number;
  reflections: number;
  routes: number;
  externalDependencies: Set<string>;
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const entryPointMarks = new Map<string, EntryPointInfo>();
  const externalDependencies = new Set<string>();
  let injections = 0;
  let reflections = 0;
  let routes = 0;

  const externalNode = (pkg: string): string => {
    const id = externalNodeId(pkg);
    if (!knownNodeIds.has(id)) {
      nodes.push({
        id,
        kind: "external_symbol",
        qualifiedName: id,
        filePath: null,
        properties: { name: pkg, package: pkg, external: true },
      });
      knownNodeIds.add(id);
    }
    externalDependencies.add(pkg);
    return id;
  };

  const unknownNode = (id: string, name: string, props: Record<string, unknown>): string => {
    if (!knownNodeIds.has(id)) {
      nodes.push({
        id,
        kind: "unknown_symbol",
        qualifiedName: id,
        filePath: parsed.filePath,
        properties: { name, ...props },
      });
      knownNodeIds.add(id);
    }
    return id;
  };

  // External imports become first-class nodes so unused third-party surface
  // is queryable instead of silently dropped.
  for (const imp of parsed.imports) {
    if (!imp.module || isRelativeSpecifier(imp.module)) continue;
    const candidate = imp.module.replace(/^\?suffix:/, "");
    if (index.moduleExists(candidate) || index.matchModuleSuffix(candidate).length > 0) continue;
    const pkg = externalPackageOf(imp.module);
    if (!pkg) continue;
    const target = externalNode(pkg);
    edges.push({
      source: importNodeId(imp.fqn),
      target,
      kind: "REFERENCES",
      properties: {
        external: true,
        member: imp.importedName ?? imp.simpleName,
      },
    });
  }

  for (const inj of parsed.injections ?? []) {
    const owner = inj.ownerId;
    if (!owner) continue;
    injections++;
    // Primitive/structural types carry no dependency identity, so they get a
    // count but no target edge (`@Body() body: { id: string }`).
    if (isBuiltinTypeText(inj.type)) continue;
    const scoped = resolveTypeCandidates(parsed, index, inj.type);
    let target: string | undefined = scoped.length === 1 ? scoped[0] : undefined;
    let isExternal = false;
    if (!target && parsed.language !== "java") {
      const resolved = resolveInjectionTarget(parsed, index, inj.type);
      if (resolved?.targetId) {
        target = resolved.targetId.startsWith("ext:")
          ? externalNode(resolved.external ?? inj.type)
          : resolved.targetId;
        isExternal = Boolean(resolved.external);
      }
    }
    if (!target)
      target = unknownNode(`__inject__:${inj.type || inj.name}`, inj.type || inj.name, {
        reason: "unresolved injected type",
      });
    edges.push({
      source: owner,
      target,
      kind: "INJECTS",
      properties: {
        line: inj.line,
        injectedName: inj.name,
        framework: inj.framework,
        ...(isExternal ? { external: true } : {}),
      },
    });
  }

  for (const ref of parsed.reflectiveRefs ?? []) {
    const owner = ref.enclosingMethodId || ref.enclosingTypeId;
    if (!owner) continue;
    const resolved = resolveReflectiveTarget(parsed, index, ref);
    let target = resolved?.targetId;
    let isExternal = false;
    const targetLabel = ref.target || ref.receiver || ref.mechanism;
    if (
      target?.startsWith("ext:") &&
      !isRelativeSpecifier(ref.target) &&
      !isProjectInternalTarget(ref.target, index)
    ) {
      target = externalNode(resolved?.external ?? targetLabel);
      isExternal = true;
    } else if (!target || target.startsWith("ext:")) {
      // Relative specifiers (`./plugins/${name}`) stay inside the project but
      // cannot be named statically, so they are recorded, not externalised.
      target = unknownNode(`__reflect__:${targetLabel}`, targetLabel, {
        reason: "unresolved reflective target",
        mechanism: ref.mechanism,
      });
    }
    reflections++;
    edges.push({
      source: owner,
      target,
      kind: "REFLECTS",
      properties: {
        line: ref.line,
        mechanism: ref.mechanism,
        ...(isExternal ? { external: true } : {}),
      },
    });
  }

  for (const route of parsed.routes ?? []) {
    const owner = route.enclosingTypeId;
    if (!owner) continue;
    const handlerId = resolveRouteHandler(parsed, index, route.handlerName, route.moduleId);
    if (!handlerId) continue;
    routes++;
    edges.push({
      source: owner,
      target: handlerId,
      kind: "ROUTES",
      properties: {
        line: route.line,
        framework: route.framework,
        httpMethod: route.httpMethod,
        path: route.path,
      },
    });
    entryPointMarks.set(handlerId, {
      kind: "http",
      detail: `${route.httpMethod} ${route.path}`,
    });
  }

  if (parsed.entryPoint) {
    const moduleType = parsed.types.find((t) => t.kind === "module");
    if (moduleType) entryPointMarks.set(moduleType.id, parsed.entryPoint);
  }

  return {
    nodes,
    edges,
    entryPointMarks,
    injections,
    reflections,
    routes,
    externalDependencies,
  };
}

/** Type texts that name no project entity: primitives and inline structures. */
const BUILTIN_TYPE_NAMES = new Set([
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "void",
  "never",
  "object",
  "symbol",
  "bigint",
  "null",
  "undefined",
  "str",
  "int",
  "float",
  "bool",
  "bytes",
  "bytearray",
  "list",
  "dict",
  "set",
  "tuple",
  "frozenset",
  "None",
  "Any",
  "Optional",
]);

function isBuiltinTypeText(raw: string): boolean {
  const text = normalizeTypeText(raw);
  if (!text) return false;
  if (BUILTIN_TYPE_NAMES.has(text)) return true;
  // Inline object/function types (`{ id: string }`, `() => void`).
  return /[{}()=>]/.test(text);
}

/** True for `./x`, `../y` and `?suffix:` specifiers that stay in-project. */
function isRelativeSpecifier(specifier: string): boolean {
  const text = (specifier ?? "").trim();
  return text.startsWith(".") || text.startsWith("?suffix:");
}

/**
 * True when a run-time module lookup names a package the project itself owns.
 * `importlib.import_module("app.plugins." + name)` yields the prefix
 * `app.plugins.` — that is a project namespace, not a third-party library, so
 * it must not be reported as an external dependency.
 */
function isProjectInternalTarget(
  specifier: string,
  index: ReturnType<typeof buildTypeIndex>
): boolean {
  const dotted = (specifier ?? "")
    .replace(/^\?suffix:/, "")
    .replace(/^\.+\//, "")
    .replace(/[/\\]/g, ".")
    .replace(/\.+$/, "")
    .trim();
  const root = dotted.split(".")[0];
  if (!root) return false;
  for (const moduleId of index.moduleIds) {
    if (moduleId === root || moduleId.startsWith(`${root}.`)) return true;
  }
  return false;
}

/** First package/specifier segment of an import target. */
function externalPackageOf(specifier: string): string {
  const text = specifier.replace(/^\?suffix:/, "").trim();
  if (!text) return "";
  if (text.startsWith("@")) {
    const parts = text.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : text;
  }
  return text.split("/")[0]?.split(".")[0] ?? text;
}

/** Compare paths the way the host filesystem does (case-insensitive on Windows). */
function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameProjectPath(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** True when `file` is strictly below `root`. */
function isInsideProject(file: string, root: string): boolean {
  const rel = path.relative(normalizePathForCompare(root), normalizePathForCompare(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Crawl a project directory and index it into the store.
 * Idempotent: re-crawling refreshes the graph; files that disappeared are
 * removed from the index. The index holds one project at a time; crawling a
 * different project fails before mutating anything.
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

  // The store is a single-project database. Without this guard a second crawl
  // would prune every file of the first project as "stale" and silently wipe it.
  const indexedProject = store.getMeta("last_project_path");
  if (indexedProject && !sameProjectPath(indexedProject, absPath)) {
    throw new Error(
      `index already contains ${indexedProject}; refusing to replace it with ${absPath}. ` +
        `A database holds one project, so give this one its own: register a separate MCP ` +
        `server per project (each then resolves its own .code-crawler/index.db), or point ` +
        `CODECRAWLER_DB at another file. To replace the existing index instead, run clear_index.`
    );
  }

  // Stale pruning is only meaningful for a full scan. fileFilter and a forced
  // language narrow the scan, so files outside that scope must be left alone.
  const scopedScan = Boolean(options.fileFilter || options.language);

  const files = discoverSourceFiles(absPath, excludeDirs, {
    language: options.language,
    respectGitignore: options.respectGitignore,
  });
  if (options.fileFilter) {
    const filter = options.fileFilter;
    files.splice(0, files.length, ...files.filter((f) => f.includes(filter)));
  }

  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const force = options.force === true;
  const skipSampleBytes = 8192;

  // Incremental crawl: the manifest records size + mtime + content hash for
  // every indexed file, together with its parse result. A file whose metadata
  // is unchanged is replayed from the cache; a file whose metadata changed but
  // whose hash matches was only touched and is replayed too.
  const manifest = store.listFileRecords();
  const parsedFiles: ParsedFile[] = [];
  const parseErrors: string[] = [];
  const skippedFiles: SkippedFile[] = [];
  const changedPaths = new Set<string>();
  const recordsToWrite = new Map<string, FileRecord>();
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesUnchanged = 0;

  interface PendingParse {
    path: string;
    size: number;
    mtimeMs: number;
  }
  const pendingParses: PendingParse[] = [];

  // Pass 1: stat only. Cheap enough to run over every discovered file and it
  // decides whether any real parsing (or indexing) work is needed at all.
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > maxFileBytes) {
        skippedFiles.push({ path: file, reason: "too-large" });
        continue;
      }
      const record = manifest.get(file);
      const mtimeMs = Math.trunc(stat.mtimeMs);
      if (!force && record && record.size === stat.size && record.mtimeMs === mtimeMs) {
        const cached = decodeParsedFile(record.summary);
        if (cached) {
          filesUnchanged++;
          parsedFiles.push(cached);
          continue;
        }
      }
      pendingParses.push({ path: file, size: stat.size, mtimeMs });
    } catch (err) {
      if (parseErrors.length < 50) {
        parseErrors.push(`${file}: ${(err as Error).message}`);
      }
    }
  }

  // Pass 2: read, hash and (only when the content really changed) parse.
  // Each file is read once: the same buffer provides the binary sniff, the
  // content hash, the source text, and the line count.
  let processedFiles = 0;
  for (const pending of pendingParses) {
    const file = pending.path;
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.subarray(0, skipSampleBytes).includes(0)) {
        skippedFiles.push({ path: file, reason: "binary" });
        continue;
      }
      const config = languageForFile(file, options.language);
      if (!config) continue;

      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const record = manifest.get(file);
      if (!force && record && record.sha256 === sha256) {
        const cached = decodeParsedFile(record.summary);
        if (cached) {
          // Same content, new timestamp: refresh metadata without re-parsing.
          filesUnchanged++;
          parsedFiles.push(cached);
          recordsToWrite.set(file, { ...record, size: pending.size, mtimeMs: pending.mtimeMs });
          continue;
        }
      }

      const source = buffer.toString("utf8");
      const parsed = await config.parseFile(source, file, { projectRoot: absPath });
      const full: ParsedFile = { ...parsed, lineCount: source.split("\n").length };
      parsedFiles.push(full);
      changedPaths.add(file);
      if (record) filesUpdated++;
      else filesAdded++;
      recordsToWrite.set(file, {
        path: file,
        size: pending.size,
        mtimeMs: pending.mtimeMs,
        sha256,
        language: full.language,
        summary: encodeParsedFile(full),
      });
    } catch (err) {
      if (parseErrors.length < 50) {
        parseErrors.push(`${file}: ${(err as Error).message}`);
      }
    } finally {
      processedFiles++;
      options.onProgress?.({
        phase: "parse",
        processed: processedFiles,
        total: pendingParses.length,
      });
      // Parsing is synchronous once a grammar is loaded; yield so the stdio
      // server can answer requests during long crawls.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Global index for cross-file resolution.
  const index = buildTypeIndex(parsedFiles);

  // Build nodes + edges per file and persist file-scoped.
  const previouslyIndexed = new Set(
    store
      .raw<{ file_path: string }>(
        "SELECT DISTINCT file_path FROM nodes WHERE file_path IS NOT NULL"
      )
      .map((r) => r.file_path)
  );
  const currentFiles = new Set(files);
  let filesRemoved = 0;
  let orphansRemoved = 0;
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
  const dependencyGraphs = new Map<string, ReturnType<typeof buildDependencyGraph>>();
  const entryPointMarks = new Map<string, EntryPointInfo>();
  const externalDeps = new Set<string>();
  let totalInjections = 0;
  let totalReflections = 0;
  let totalRoutes = 0;

  for (const parsed of parsedFiles) {
    const decl = buildDeclarationGraph(parsed);
    declarations.set(parsed.filePath, decl);
    for (const n of decl.nodes) allNodeIds.add(n.id);

    const deps = buildDependencyGraph(parsed, index, allNodeIds);
    dependencyGraphs.set(parsed.filePath, deps);
    for (const n of deps.nodes) allNodeIds.add(n.id);
    for (const [id, info] of deps.entryPointMarks) entryPointMarks.set(id, info);
    totalInjections += deps.injections;
    totalReflections += deps.reflections;
    totalRoutes += deps.routes;
    for (const pkg of deps.externalDependencies) externalDeps.add(pkg);
  }

  // Route handlers can live in a different file from the registration site,
  // so entry-point markers are applied once every declaration exists.
  for (const decl of declarations.values()) {
    for (const node of decl.nodes) {
      const mark = entryPointMarks.get(node.id);
      if (!mark || node.properties.entryPoint) continue;
      node.properties = {
        ...node.properties,
        entryPoint: true,
        entryPointKind: mark.kind,
        entryPointDetail: mark.detail ?? mark.kind,
      };
    }
  }

  const entryPointIds = new Set<string>();
  for (const decl of declarations.values()) {
    for (const node of decl.nodes) {
      if (node.properties.entryPoint) entryPointIds.add(node.id);
    }
  }

  // Nodes owned by files this crawl rewrote; their rows already carry the
  // markers computed above, so only the rest need a targeted update.
  const changedNodeIds = new Set<string>();
  for (const parsed of parsedFiles) {
    if (!changedPaths.has(parsed.filePath)) continue;
    for (const node of declarations.get(parsed.filePath)?.nodes ?? []) {
      changedNodeIds.add(node.id);
    }
  }

  // Hierarchy metadata is emitted with whatever name the source used
  // (`implements Payment`), which is not always the fully-qualified node id.
  // Resolve imports first, then fall back to unique simple names.
  const typeIdsByName = new Map<string, string[]>();
  for (const parsed of parsedFiles) {
    for (const t of parsed.types) {
      const ids = typeIdsByName.get(t.name) ?? [];
      if (!ids.includes(t.id)) ids.push(t.id);
      typeIdsByName.set(t.name, ids);
    }
  }
  const byFilePath = new Map(parsedFiles.map((p) => [p.filePath, p]));
  const normalizeHierarchyTarget = (edge: GraphEdge, filePath: string): GraphEdge => {
    if (edge.kind !== "EXTENDS" && edge.kind !== "IMPLEMENTS") return edge;
    if (allNodeIds.has(edge.target)) return edge;
    const parsed = byFilePath.get(filePath);
    if (parsed) {
      const scoped = resolveTypeCandidates(parsed, index, edge.target).filter((id) =>
        allNodeIds.has(id)
      );
      const only = scoped[0];
      if (scoped.length === 1 && only) return { ...edge, target: only };
    }
    const simple = edge.target.includes(".")
      ? (edge.target.split(".").pop() ?? edge.target)
      : edge.target;
    const candidates = typeIdsByName.get(simple);
    const resolved = candidates?.length === 1 ? candidates[0] : undefined;
    return resolved ? { ...edge, target: resolved } : edge;
  };

  let persistedFiles = 0;
  store.withTransaction(() => {
    for (const parsed of parsedFiles) {
      const decl = declarations.get(parsed.filePath);
      const deps = dependencyGraphs.get(parsed.filePath);
      if (!decl || !deps) {
        throw new Error(`missing parse result for ${parsed.filePath}`);
      }
      const calls = buildCallEdges(parsed, index, allNodeIds);

      for (const pkg of calls.externalPackages) externalDeps.add(pkg);

      for (const p of calls.phantomNodes) allNodeIds.add(p.id);

      // Unchanged files keep their existing rows: re-resolving them would
      // rewrite identical data and defeat the point of an incremental crawl.
      if (changedPaths.has(parsed.filePath)) {
        // Phantom nodes must exist as edge endpoints (FK constraint).
        for (const p of calls.phantomNodes) store.ensureNode(p);

        // Drop edges whose endpoints aren't part of the indexed project
        // (external EXTENDS/IMPLEMENTS/IMPORTS targets).
        const edges = decl.edges
          .map((edge) => normalizeHierarchyTarget(edge, parsed.filePath))
          .concat(calls.edges, deps.edges)
          .filter((e) => allNodeIds.has(e.source) && allNodeIds.has(e.target));
        const nodes = decl.nodes.concat(calls.phantomNodes, deps.nodes);
        store.replaceFile(parsed.filePath, nodes, edges);
      }

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
      persistedFiles++;
      options.onProgress?.({
        phase: "persist",
        processed: persistedFiles,
        total: parsedFiles.length,
      });
    }

    // Remove files that disappeared from the project. Only a full scan knows
    // the complete file set, and only files under this project belong to it.
    if (!scopedScan) {
      for (const stale of previouslyIndexed) {
        if (currentFiles.has(stale) || !isInsideProject(stale, absPath)) continue;
        store.removeFile(stale);
        filesRemoved++;
      }
    }

    // Refresh the manifest for parsed files and for untouched-but-retimed ones.
    for (const record of recordsToWrite.values()) store.putFileRecord(record);

    // Entry points can be registered in one file and declared in another. Only
    // changed files were rewritten, so handlers living in unchanged files need
    // the marker applied directly.
    for (const [id, mark] of entryPointMarks) {
      if (changedNodeIds.has(id)) continue;
      store.markEntryPoint(id, mark.kind, mark.detail ?? mark.kind);
    }

    // Rebuild project-wide derived edges: virtual dispatch and AOP advice.
    // Nothing changed, so the existing derived edges are still correct.
    if (changedPaths.size > 0 || filesRemoved > 0) {
      store.deleteEdgesByKind(["DYNAMIC_DISPATCH", "ADVISES"]);
      const dynamic = buildDynamicEdges(parsedFiles, index, allNodeIds, allCallEdges);
      store.upsertEdges(dynamic.edges);
      dynamicDispatchCount = dynamic.dispatchCount;
      adviceCount = dynamic.adviceCount;
      aspectCount = dynamic.aspects;

      // Shared file-less nodes (packages, annotations, external symbols)
      // outlive the files that created them; collect the unreferenced ones.
      orphansRemoved = store.pruneOrphanNodes();
    }
  });

  store.setMeta("last_crawl_at", new Date().toISOString());
  store.setMeta("last_project_path", absPath);

  const stats = store.stats();
  return {
    projectPath: absPath,
    filesScanned: files.length,
    filesParsed: parsedFiles.length,
    filesAdded,
    filesUpdated,
    filesUnchanged,
    filesRemoved,
    filesSkipped: skippedFiles.length,
    skippedFiles,
    parseErrors,
    pruned: !scopedScan,
    orphansRemoved,
    nodes: stats.nodes,
    edges: stats.edges,
    resolvedCalls: totalResolved,
    unresolvedCalls: totalUnresolved,
    dynamicDispatchEdges: dynamicDispatchCount,
    adviceEdges: adviceCount,
    aspects: aspectCount,
    decorators: totalDecorators,
    entryPoints: entryPointIds.size,
    injections: totalInjections,
    reflections: totalReflections,
    externalDependencies: externalDeps.size,
    routes: totalRoutes,
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
