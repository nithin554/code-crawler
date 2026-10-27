/**
 * Graph schema for the code-crawler property graph.
 *
 * The graph is a labelled property graph stored in SQLite:
 *   - Nodes represent source-level symbols (files, classes, methods, fields, ...)
 *   - Directed edges represent relationships between symbols (calls, contains, ...)
 *
 * Both nodes and edges carry an arbitrary `properties` JSON blob so languages
 * can attach extra metadata (signatures, modifiers, confidence scores) without
 * schema migrations.
 */

export const NODE_KINDS = [
  "file",
  "package",
  "module",
  "class",
  "interface",
  "enum",
  "annotation_type",
  "annotation",
  "aspect",
  "method",
  "constructor",
  "field",
  "import",
  "external_symbol",
  "unknown_symbol",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "CALLS",
  "DYNAMIC_DISPATCH",
  "ADVISES",
  "DECLARED_IN",
  "CONTAINS",
  "IMPLEMENTS",
  "EXTENDS",
  "IMPORTS",
  "ANNOTATED_WITH",
  "REFERENCES",
  "REFLECTS",
  "INJECTS",
  "ROUTES",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Kinds that may appear as call *targets* (nodes at the arrow end of CALLS). */
export const CALLABLE_KINDS: readonly NodeKind[] = ["method", "constructor"];

/** Kinds that can be annotated/decorated. */
export const DECORATABLE_KINDS: readonly NodeKind[] = [
  "class",
  "interface",
  "enum",
  "annotation_type",
  "aspect",
  "method",
  "constructor",
  "field",
];

export interface NodeProperties {
  /** Zero-based line of the declaration start. */
  startLine?: number;
  /** Zero-based line of the declaration end. */
  endLine?: number;
  /** Short display name (method/field/class simple name). */
  name?: string;
  /** Fully-qualified name when distinct from the node id. */
  qualifiedName?: string;
  /** Simple names of annotations/decorators applied to this symbol. */
  annotations?: string[];
  /** True when a class is an aspect (e.g. annotated with `@Aspect`). */
  aspect?: boolean;
  /** For advice methods: before | after | around | afterReturning | afterThrowing. */
  adviceKind?: string;
  /** For advice/pointcut methods: the AspectJ pointcut expression. */
  pointcut?: string;
  /** Free-form language-specific metadata. */
  [key: string]: string | number | boolean | (string | number)[] | undefined;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Globally unique fully-qualified name, e.g. `com.acme.Foo#run`. */
  qualifiedName: string;
  /** Absolute path of the source file that declares this symbol. */
  filePath: string | null;
  properties: NodeProperties;
}

export interface EdgeProperties {
  /** Zero-based line number of the call site / reference. */
  line?: number;
  /** For CALLS edges: whether the target was statically resolved. */
  resolved?: boolean;
  /** For CALLS edges: heuristic confidence 0..1 when resolved. */
  confidence?: number;
  /** For DYNAMIC_DISPATCH: why the runtime target was inferred. */
  via?: string;
  /** For ADVISES: the advice kind that intercepts the call. */
  adviceKind?: string;
  /** For ADVISES: the pointcut expression that matched. */
  pointcut?: string;
  /** For ANNOTATED_WITH: raw annotation arguments as written in source. */
  arguments?: string[];
  /** For CALLS: true when the call is nested inside a branch/loop/handler. */
  conditional?: boolean;
  /** For CALLS: enclosing control-flow categories (branch/loop/exception/predicate). */
  controlFlow?: string[];
  /** For CALLS: compact source text of the enclosing conditions. */
  guards?: string[];
  /** For CALLS/IMPORTS: the target is outside the crawled source tree. */
  external?: boolean;
  /** For INJECTS: framework that performs the injection. */
  framework?: string;
  /** For REFLECTS: the run-time lookup mechanism (`Class.forName`, `getattr`). */
  mechanism?: string;
  /** For entry-point metadata: the framework-invoked root category. */
  entryPointKind?: string;
  /** For entry-point metadata: human-readable route/schedule detail. */
  entryPointDetail?: string;
  /** For INJECTS: injected field/parameter name. */
  injectedName?: string;
  /** For IMPORTS/REFERENCES: imported member name. */
  member?: string;
  /** Free-form language-specific metadata. */
  [key: string]: string | number | boolean | (string | number)[] | undefined;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  properties: EdgeProperties;
}

/** Node id scheme. `#` separates type from member so FQNs stay readable. */
export function methodNodeId(qualifiedType: string, methodName: string): string {
  return `${qualifiedType}#${methodName}`;
}

export function constructorNodeId(qualifiedType: string): string {
  return `${qualifiedType}#<init>`;
}

/** Field ids use `$` so they never collide with nested-type FQNs (`.`). */
export function fieldNodeId(qualifiedType: string, fieldName: string): string {
  return `${qualifiedType}$${fieldName}`;
}

/** Import nodes represent external (or unindexed) dependencies. */
export function importNodeId(fqn: string): string {
  return `__import__:${fqn}`;
}

/** Fallback id for calls that could not be statically resolved. */
export function unknownNodeId(qualifiedName: string): string {
  return `__unknown__:${qualifiedName}`;
}

/** External dependency nodes are grouped per package/specifier. */
export function externalNodeId(specifier: string): string {
  return `ext:${specifier}`;
}

/**
 * Annotation/decorator ids share one node per annotation name so that
 * `find_annotated` and `get_decorators` can pivot across the whole project.
 */
export function annotationNodeId(name: string): string {
  return `@${name}`;
}
