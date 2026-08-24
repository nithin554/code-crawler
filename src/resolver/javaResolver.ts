import type { JavaParsedFile } from "../parser/languages/java.js";
import { phantomNodeId, type ResolvedCall, type TypeIndex } from "./types.js";

/**
 * Java call-target resolution (v1 heuristics).
 *
 * Resolution strategy, in order of certainty:
 *   1. Constructor calls (`new Foo(...)`) resolve `Foo` -> type -> `#<init>`.
 *   2. Bare / `this.` / `super.` calls search the enclosing type and its
 *      superclass chain.
 *   3. Type-qualified calls (`com.acme.Foo.bar`) resolve the type directly.
 *   4. Instance calls (`x.method()`) infer the receiver's declared type from
 *      locals, parameters, and fields, then search that type + ancestors.
 *   5. Anything else becomes a phantom `unknown_symbol` node with an
 *      `resolved:false` edge so the graph stays traversable.
 */

export interface ResolveOptions {
  /** Treat inherited methods as resolvable targets. Default true. */
  searchInheritance?: boolean;
}

export function resolveJavaFile(
  file: JavaParsedFile,
  index: TypeIndex,
  options: ResolveOptions = {}
): ResolvedCall[] {
  const searchInheritance = options.searchInheritance ?? true;
  const results: ResolvedCall[] = [];

  for (const call of file.callSites) {
    results.push(resolveCall(call, file, index, searchInheritance));
  }

  return results;
}

function resolveCall(
  call: ResolvedCall["callSite"],
  file: JavaParsedFile,
  index: TypeIndex,
  searchInheritance: boolean
): ResolvedCall {
  const phantom = {
    callSite: call,
    targetId: phantomNodeId(call),
    resolved: false,
    confidence: 0,
    reason: "",
  };

  // ---- 1. Constructor calls ------------------------------------------------
  if (call.isConstructorCall) {
    const types = resolveTypeName(call.name, file, index);
    if (types.length === 0) {
      return { ...phantom, reason: `type "${call.name}" not found in project` };
    }
    for (const fqn of types) {
      const ctor = `${fqn}#<init>`;
      if (index.methodsByFqn.get(fqn)?.some((m) => m.id === ctor)) {
        return {
          callSite: call,
          targetId: ctor,
          resolved: true,
          confidence: 1.0,
          reason: `constructor of ${fqn}`,
        };
      }
    }
    // Constructor not explicitly declared: Java provides the default one.
    return {
      callSite: call,
      targetId: `${types[0]}#<init>`,
      resolved: true,
      confidence: 0.9,
      reason: `default constructor of ${types[0]}`,
    };
  }

  // ---- Receiver candidate extraction ---------------------------------------
  const candidates = receiverCandidates(call, file, index);
  if (candidates.types.length === 0) {
    return {
      ...phantom,
      reason: `could not infer receiver type: ${candidates.how}`,
    };
  }

  for (const typeFqn of candidates.types) {
    const found = findMethod(typeFqn, call.name, call.argumentTexts.length, index, searchInheritance);
    if (found) {
      return {
        callSite: call,
        targetId: found.method.id,
        resolved: true,
        confidence: baseConfidence(candidates) * found.confidence,
        reason: `${found.method.id} (via ${candidates.how}${found.inherited ? ", inherited" : ""})`,
      };
    }
  }

  return {
    ...phantom,
    reason: `no method ${call.name}(${call.argumentTexts.length} args) on ${candidates.types.join(" | ")} (${candidates.how})`,
  };
}

interface CandidateSet {
  types: string[];
  how: string;
}

/**
 * Compute the candidate receiver types for an invocation, in priority order.
 */
function receiverCandidates(call: ResolvedCall["callSite"], file: JavaParsedFile, index: TypeIndex): CandidateSet {
  const receiver = call.receiver;

  // ---- 2. Bare / this / super calls ----------------------------------------
  if (!receiver) {
    return {
      types: enclosingAndAncestors(call.enclosingTypeId, index),
      how: "bare call in " + call.enclosingTypeId,
    };
  }
  if (receiver === "this" || receiver.startsWith("this.")) {
    const field = receiver.startsWith("this.")
      ? file.fields.find((f) => f.typeId === call.enclosingTypeId && f.name === receiver.slice(5))
      : null;
    if (field) {
      const types = resolveTypeName(field.type, file, index);
      return { types, how: `field ${receiver} of ${call.enclosingTypeId}` };
    }
    return {
      types: enclosingAndAncestors(call.enclosingTypeId, index),
      how: `this-call in ${call.enclosingTypeId}`,
    };
  }
  if (receiver.startsWith("super.")) {
    return {
      types: superAncestors(call.enclosingTypeId, index),
      how: `super-call from ${call.enclosingTypeId}`,
    };
  }

  // ---- 3. Type-qualified static calls --------------------------------------
  const asType = resolveTypeName(receiver, file, index);
  if (asType.length > 0) {
    return { types: asType, how: `static/type-qualified on ${receiver}` };
  }

  // ---- 4. Instance calls on a variable -------------------------------------
  if (isNameLike(receiver)) {
    const inferred = inferVariableType(receiver, call, file, index);
    if (inferred.types.length > 0) return inferred;
  }

  // ---- Fallback: `new Foo().method()` and other expressions ----------------
  const newMatch = receiver.match(/^new\s+([\w.$]+)/);
  if (newMatch && newMatch[1]) {
    const types = resolveTypeName(newMatch[1], file, index);
    return { types, how: `receiver created via new ${newMatch[1]}()` };
  }

  return { types: [], how: `unhandled receiver expression "${receiver}"` };
}

/** Infer a variable's declared type from locals, parameters, and fields. */
function inferVariableType(
  name: string,
  call: ResolvedCall["callSite"],
  file: JavaParsedFile,
  index: TypeIndex
): CandidateSet {
  // locals in the enclosing method
  const locals = file.localsByMethod.get(call.enclosingMethodId);
  const localType = locals?.get(name);
  if (localType) {
    return { types: resolveTypeName(localType, file, index), how: `local ${name}: ${localType}` };
  }
  // parameters of the enclosing method
  const method = file.methods.find((m) => m.id === call.enclosingMethodId);
  const param = method?.params.find((p) => p.name === name);
  if (param) {
    return { types: resolveTypeName(param.type, file, index), how: `param ${name}: ${param.type}` };
  }
  // fields of the enclosing type
  const field = file.fields.find((f) => f.typeId === call.enclosingTypeId && f.name === name);
  if (field) {
    return { types: resolveTypeName(field.type, file, index), how: `field ${name}: ${field.type}` };
  }
  // inherited fields (search ancestors of the enclosing type)
  for (const anc of superAncestors(call.enclosingTypeId, index)) {
    const ancField = file.fields.find((f) => f.typeId === anc && f.name === name);
    if (ancField) {
      return { types: resolveTypeName(ancField.type, file, index), how: `field ${name} inherited from ${anc}` };
    }
  }
  return { types: [], how: `unknown variable "${name}"` };
}

interface FoundMethod {
  method: { id: string };
  confidence: number;
  inherited: boolean;
}

/** Find a method on a type or (optionally) its ancestors, matching arity. */
function findMethod(
  typeFqn: string,
  methodName: string,
  argCount: number,
  index: TypeIndex,
  searchInheritance: boolean
): FoundMethod | null {
  const direct = (index.methodsByFqn.get(typeFqn) ?? []).filter((m) => m.name === methodName);
  const match = pickOverload(direct, argCount);
  if (match) return { method: { id: match.id }, confidence: 1.0, inherited: false };

  if (searchInheritance) {
    const inherited = findInherited(typeFqn, methodName, argCount, index, new Set(), 0);
    if (inherited) return inherited;
  }
  return null;
}

function findInherited(
  typeFqn: string,
  methodName: string,
  argCount: number,
  index: TypeIndex,
  visited: Set<string>,
  depth: number
): FoundMethod | null {
  if (depth > 10 || visited.has(typeFqn)) return null;
  visited.add(typeFqn);
  for (const parentName of index.parentsByFqn.get(typeFqn) ?? []) {
    for (const parent of index.resolveType(parentName)) {
      const candidates = (index.methodsByFqn.get(parent) ?? []).filter((m) => m.name === methodName);
      const match = pickOverload(candidates, argCount);
      if (match) {
        return { method: { id: match.id }, confidence: 0.9, inherited: true };
      }
      const deeper = findInherited(parent, methodName, argCount, index, visited, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** Pick the overload with matching arity; fall back to the first candidate. */
function pickOverload(methods: { id: string; name: string; params: unknown[] }[], argCount: number) {
  const exact = methods.find((m) => m.params.length === argCount);
  if (exact) return exact;
  return methods[0] ?? null;
}

/** Enclosing type + all ancestors, deduped, in order. */
function enclosingAndAncestors(typeFqn: string, index: TypeIndex): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
    for (const parent of index.parentsByFqn.get(t) ?? []) {
      for (const resolved of index.resolveType(parent)) walk(resolved);
    }
  };
  walk(typeFqn);
  return out;
}

function superAncestors(typeFqn: string, index: TypeIndex): string[] {
  return enclosingAndAncestors(typeFqn, index).slice(1);
}

/**
 * Resolve a type name (simple or qualified) to candidate FQNs.
 * Priority: exact FQN in index -> file-declared/imported -> same package ->
 * java.lang -> any simple-name match.
 */
function resolveTypeName(name: string, file: JavaParsedFile, index: TypeIndex): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];

  if (index.kindByFqn.has(trimmed)) return [trimmed];

  // java.lang implicit types
  if (index.kindByFqn.has(`java.lang.${trimmed}`)) return [`java.lang.${trimmed}`];

  // same package
  const simple = trimmed.includes(".") ? trimmed.split(".").pop()! : trimmed;
  const inFile = file.typeByName.get(simple);
  if (inFile) return [inFile];

  if (file.packageName) {
    const pkgQualified = `${file.packageName}.${simple}`;
    if (index.kindByFqn.has(pkgQualified)) return [pkgQualified];
  }

  return index.resolveType(simple);
}

/** Whether a receiver looks like a plain (possibly dotted) name. */
function isNameLike(receiver: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(receiver);
}

function baseConfidence(candidates: CandidateSet): number {
  switch (candidates.how.split(" ")[0]) {
    case "local":
    case "static/type-qualified":
    case "param":
      return 1.0;
    case "field":
    case "bare":
    case "this-call":
    case "super-call":
      return 0.95;
    case "receiver":
      return 0.85;
    default:
      return 0.7;
  }
}
