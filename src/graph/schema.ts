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
  "class",
  "interface",
  "enum",
  "method",
  "constructor",
  "field",
  "import",
  "unknown_symbol",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "CALLS",
  "DECLARED_IN",
  "CONTAINS",
  "IMPLEMENTS",
  "EXTENDS",
  "IMPORTS",
  "REFERENCES",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** Kinds that may appear as call *targets* (nodes at the arrow end of CALLS). */
export const CALLABLE_KINDS: readonly NodeKind[] = ["method", "constructor"];

export interface NodeProperties {
  /** Zero-based line of the declaration start. */
  startLine?: number;
  /** Zero-based line of the declaration end. */
  endLine?: number;
  /** Short display name (method/field/class simple name). */
  name?: string;
  /** Fully-qualified name when distinct from the node id. */
  qualifiedName?: string;
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
  /** Free-form language-specific metadata. */
  [key: string]: string | number | boolean | undefined;
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
