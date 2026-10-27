import type { ControlFlowInfo, ControlFlowKind } from "./language.js";
import type { TSNode } from "./treeSitter.js";

/**
 * Control-flow context for a call site.
 *
 * Static call graphs say "A calls B"; they do not say whether B is reached
 * unconditionally, only inside a branch, in a loop, or in an exception handler.
 * The parsers walk ancestors of every call site and record that context, which
 * is attached to the CALLS edge. This is still not path-sensitive: it describes
 * the syntactic guards directly enclosing the call, not the full predicate.
 */

export interface FlowSpec {
  /** Grammar node type to match. */
  type: string;
  /** Control-flow category contributed by the node. */
  kind: ControlFlowKind;
  /** Field holding the guard expression text (`condition`, `value`, ...). */
  guardField?: string;
  /** Static guard label used when the node has no expression (e.g. `else`). */
  guard?: string;
  /** For operator nodes: only count when the operator is one of these. */
  operatorIn?: string[];
}

const MAX_GUARDS = 3;
const MAX_GUARD_LENGTH = 160;

/** Nearest enclosing callable body; stops the ancestor walk. */
const BODY_BOUNDARY = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "constructor",
  "arrow_function",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "lambda",
]);

/** Walk ancestors of `node` collecting the control-flow context. */
export function controlFlowOf(node: TSNode, specs: FlowSpec[]): ControlFlowInfo | undefined {
  const kinds: ControlFlowKind[] = [];
  const guards: string[] = [];
  let current = node.parent;
  let hops = 0;

  while (current && hops < 60) {
    const type = current.type;
    if (BODY_BOUNDARY.has(type)) break;
    const spec = specs.find((s) => s.type === type);
    if (spec) {
      if (spec.operatorIn && !spec.operatorIn.includes(operatorOf(current))) {
        current = current.parent;
        hops++;
        continue;
      }
      if (!kinds.includes(spec.kind)) kinds.push(spec.kind);
      const guard = spec.guard ?? guardText(current, spec.guardField);
      if (guard && !guards.includes(guard) && guards.length < MAX_GUARDS) guards.push(guard);
    }
    current = current.parent;
    hops++;
  }

  if (kinds.length === 0) return undefined;
  return { kinds, guards };
}

/** True when `node` is nested inside any of the given node types. */
export function insideAny(node: TSNode, types: ReadonlySet<string>, limit = 60): boolean {
  let current = node.parent;
  let hops = 0;
  while (current && hops < limit) {
    if (types.has(current.type)) return true;
    current = current.parent;
    hops++;
  }
  return false;
}

function operatorOf(node: TSNode): string {
  const operator = node.childForFieldName("operator");
  if (operator) return operator.text;
  for (const child of node.children) {
    if (child.type === "&&" || child.type === "||" || child.type === "??") return child.type;
  }
  return "";
}

function guardText(node: TSNode, field?: string): string {
  if (!field) return "";
  const child = node.childForFieldName(field);
  if (!child) return "";
  const compact = child.text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > MAX_GUARD_LENGTH
    ? `${compact.slice(0, MAX_GUARD_LENGTH - 1)}…`
    : compact;
}
