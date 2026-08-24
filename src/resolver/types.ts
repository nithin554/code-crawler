import type { CallSite, MethodInfo, ParsedFile, TypeKind } from "../parser/language.js";

/**
 * Shared resolver contract.
 *
 * A resolver turns raw `CallSite`s from the parser into concrete call edges.
 * Resolution is heuristic: each call site either resolves to a known method
 * node (with a confidence score) or falls back to a phantom `unknown_symbol`
 * node so the graph stays traversable.
 */

export interface ResolvedCall {
  callSite: CallSite;
  /** Method node id (`Type#method`) or phantom id for unresolved calls. */
  targetId: string;
  resolved: boolean;
  /** 0..1 heuristic confidence; 1 = statically certain. */
  confidence: number;
  /** Human-readable resolution trace for debugging and tool output. */
  reason: string;
}

/**
 * Global index over all parsed files, used to resolve type and method names
 * across the whole project. Built once per crawl pass.
 */
export class TypeIndex {
  /** simple name -> FQNs declared anywhere in the project. */
  typesBySimpleName = new Map<string, string[]>();
  /** FQN -> kind (class/interface/enum). */
  kindByFqn = new Map<string, TypeKind>();
  /** FQN -> directly-declared methods (all overloads). */
  methodsByFqn = new Map<string, MethodInfo[]>();
  /** FQN -> parent FQNs (extends/implements, resolved where possible). */
  parentsByFqn = new Map<string, string[]>();

  addFile(file: ParsedFile): void {
    for (const t of file.types) {
      const list = this.typesBySimpleName.get(t.name) ?? [];
      if (!list.includes(t.id)) list.push(t.id);
      this.typesBySimpleName.set(t.name, list);
      this.kindByFqn.set(t.id, t.kind);
      this.parentsByFqn.set(t.id, t.extendsTypes.concat(t.implementsTypes));
    }
    for (const m of file.methods) {
      const list = this.methodsByFqn.get(m.typeId) ?? [];
      list.push(m);
      this.methodsByFqn.set(m.typeId, list);
    }
  }

  /** Resolve a (possibly qualified) type name to candidate FQNs. */
  resolveType(name: string): string[] {
    const trimmed = name.trim();
    if (!trimmed) return [];
    // Exact FQN match?
    if (this.kindByFqn.has(trimmed)) return [trimmed];
    // Simple name match.
    const simple = trimmed.includes(".") ? trimmed.split(".").pop()! : trimmed;
    return this.typesBySimpleName.get(simple) ?? [];
  }

  /** All methods named `methodName` declared on a type (or inherited). */
  findMethods(typeFqn: string, methodName: string, visited = new Set<string>(), depth = 0): MethodInfo[] {
    if (depth > 10 || visited.has(typeFqn)) return [];
    visited.add(typeFqn);
    const direct = (this.methodsByFqn.get(typeFqn) ?? []).filter((m) => m.name === methodName);
    if (direct.length > 0) return direct;
    for (const parent of this.parentsByFqn.get(typeFqn) ?? []) {
      const resolved = this.resolveType(parent);
      for (const p of resolved) {
        const found = this.findMethods(p, methodName, visited, depth + 1);
        if (found.length > 0) return found;
      }
    }
    return [];
  }

  /** True when a type declares (or inherits) the named method. */
  hasMethod(typeFqn: string, methodName: string): boolean {
    return this.findMethods(typeFqn, methodName).length > 0;
  }
}

/** Build a TypeIndex from many parsed files. */
export function buildTypeIndex(files: ParsedFile[]): TypeIndex {
  const index = new TypeIndex();
  for (const f of files) index.addFile(f);
  return index;
}

/** Node id for an unresolved (phantom) call. */
export function phantomNodeId(call: CallSite): string {
  const label = call.isConstructorCall
    ? `new ${call.name}`
    : call.receiver
      ? `${call.receiver}.${call.name}`
      : call.name;
  return `__unknown__:${label}`;
}

export type { CallSite, ParsedFile };
