import type { CallSite, ParsedFile } from "../parser/language.js";
import { moduleNodeId } from "../parser/moduleId.js";
import {
  externalPackageOf,
  findInherited,
  findMethodsNamed,
  isGlobalObject,
  isPythonBuiltin,
  moduleIdOf,
  normalizeTypeText,
  pickOverload,
  resolveModuleMember,
  resolveReceiver,
  resolveScopeValue,
  resolveTypeCandidates,
} from "./common.js";
import { phantomNodeId, type ResolvedCall, type TypeIndex } from "./types.js";

/**
 * Call-target resolution for module-based languages (Python, TypeScript).
 *
 * Order of certainty:
 *   1. Constructors: `Foo(...)` / `new Foo(...)` -> resolving type -> `#<init>`.
 *   2. `this`/`self`/`cls`/`super` dispatch along the enclosing type chain.
 *   3. Receiver inference (imports, fields, locals, module values) then a
 *      method lookup on the resolved type chain.
 *   4. Module-qualified calls: `order.create()` / `svc.helper()` where the
 *      receiver is a module, resolved to a module-level function.
 *   5. Bare calls: same module, then enclosing type, then builtins/globals.
 *   6. External receivers produce `external: true` edges instead of phantoms.
 *   7. Everything else becomes a phantom `unknown_symbol` node.
 */

export interface GenericResolveOptions {
  /** Treat inherited methods as resolvable targets. Default true. */
  searchInheritance?: boolean;
}

export function resolveGenericFile(
  file: ParsedFile,
  index: TypeIndex,
  options: GenericResolveOptions = {}
): ResolvedCall[] {
  const searchInheritance = options.searchInheritance ?? true;
  return file.callSites.map((call) => resolveCall(call, file, index, searchInheritance));
}

function phantom(call: CallSite, reason: string): ResolvedCall {
  return { callSite: call, targetId: phantomNodeId(call), resolved: false, confidence: 0, reason };
}

function externalCall(call: CallSite, pkg: string, reason: string): ResolvedCall {
  return {
    callSite: call,
    targetId: `ext:${pkg}`,
    resolved: true,
    confidence: 0.8,
    reason,
    external: true,
    externalModule: pkg,
  };
}

function resolveCall(call: CallSite, file: ParsedFile, index: TypeIndex, searchInheritance: boolean): ResolvedCall {
  const name = call.name === "__init__" || call.name === "constructor" ? "<init>" : call.name;
  const argCount = call.argumentTexts.length;

  // ---- 1. Constructors ----------------------------------------------------
  if (call.isConstructorCall) {
    if (name === "<init>") {
      // `super().__init__()` dispatches to the parent constructor.
      const parents = resolveReceiver(file, index, call.receiver, call.enclosingTypeId, call.enclosingMethodId);
      const parentType = parents.types[0];
      if (parentType) {
        return { callSite: call, targetId: `${parentType}#<init>`, resolved: true, confidence: 0.85, reason: `parent constructor of ${parentType}` };
      }
    }
    const types = resolveTypeCandidates(file, index, call.name);
    if (types.length > 0) {
      for (const typeId of types) {
        const ctor = pickOverload(findMethodsNamed(index, typeId, "<init>"), argCount);
        if (ctor) {
          return { callSite: call, targetId: ctor.id, resolved: true, confidence: 1.0, reason: `constructor of ${typeId}` };
        }
      }
      return {
        callSite: call,
        targetId: `${types[0]}#<init>`,
        resolved: true,
        confidence: 0.9,
        reason: `default constructor of ${types[0]}`,
      };
    }
    const scopedType = file.scopeTypes?.get(call.name);
    const pkg = scopedType ? externalPackageOf(file, index, scopedType) : null;
    const binding = file.externalModules?.get(call.name);
    if (pkg || binding) {
      return externalCall(call, binding ?? pkg!, `${call.name} is constructed outside the crawled tree`);
    }
    if (file.language === "python" && isPythonBuiltin(call.name)) {
      return externalCall(call, "builtins", `${call.name} is a Python builtin type`);
    }
    return phantom(call, `type "${call.name}" not found in project`);
  }

  // ---- 2/3. Receiver-based dispatch --------------------------------------
  const receiver = resolveReceiver(file, index, call.receiver, call.enclosingTypeId, call.enclosingMethodId);

  if (receiver.external) {
    return externalCall(call, receiver.external, receiver.reason);
  }

  for (const typeId of receiver.types) {
    const methods = searchInheritance ? findInherited(index, typeId, name) : findMethodsNamed(index, typeId, name);
    const method = pickOverload(methods, argCount);
    if (method) {
      const inherited = method.typeId !== typeId;
      return {
        callSite: call,
        targetId: method.id,
        resolved: true,
        confidence: inherited ? 0.8 : 0.9,
        reason: inherited ? `${name} inherited from ${method.typeId} (via ${receiver.reason})` : `${name} declared on ${method.typeId} (${receiver.reason})`,
      };
    }
  }

  for (const moduleId of receiver.moduleIds) {
    const target = resolveModuleMember(index, moduleId, name);
    if (target) {
      return { callSite: call, targetId: target, resolved: true, confidence: 0.9, reason: `${name} is exported by module ${moduleId}` };
    }
  }

  // ---- 5. Bare calls -----------------------------------------------------
  if (!call.receiver) {
    const ownModule = moduleIdOf(call.enclosingTypeId) ?? file.moduleId;
    if (ownModule) {
      const target = resolveModuleMember(index, ownModule, name);
      if (target) {
        return { callSite: call, targetId: target, resolved: true, confidence: 0.9, reason: `${name} is declared in the same module` };
      }
    }
    const imported = file.scopeTypes?.get(name);
    if (imported) {
      const types = resolveTypeCandidates(file, index, imported);
      const ctorType = types[0];
      if (ctorType) {
        return { callSite: call, targetId: `${ctorType}#<init>`, resolved: true, confidence: 0.75, reason: `${name} is an imported class` };
      }
      const importModule = imported.split(".").slice(0, -1).join(".");
      const moduleId = importModule ? index.resolveModuleId(importModule) : null;
      if (moduleId) {
        const target = resolveModuleMember(index, moduleId, name);
        if (target) {
          return { callSite: call, targetId: target, resolved: true, confidence: 0.85, reason: `${name} imported from ${moduleId}` };
        }
      }
      const external = externalPackageOf(file, index, imported);
      if (external && !types.length) {
        return externalCall(call, external, `${name} is imported from external package ${external}`);
      }
    }
    if (isPythonBuiltin(name)) return externalCall(call, "builtins", `${name} is a Python builtin`);
    if (isGlobalObject(name)) return externalCall(call, name, `${name} is a runtime global`);
    if (file.language === "python" && /^[A-Z][A-Za-z0-9_]*$/.test(name)) {
      const importedPackage = externalPackageOf(file, index, name);
      if (importedPackage) return externalCall(call, importedPackage, `${name} is not declared in the project`);
    }
  }

  // ---- 7. Unresolved ----------------------------------------------------
  if (call.receiver) {
    if (file.language === "python" && isPythonBuiltin(name)) {
      return externalCall(call, "builtins", `${name} is a Python builtin`);
    }
    if (isGlobalObject(name)) return externalCall(call, name, `${name} is a runtime global`);
    return phantom(call, `${name} not found on ${receiver.reason}`);
  }
  return phantom(call, `${name} not found in module ${file.moduleId ?? file.filePath}`);
}

/**
 * Resolve a reflected target to a concrete node id.
 * Returns the type/method/module id, or an external package name.
 */
export function resolveReflectiveTarget(
  file: ParsedFile,
  index: TypeIndex,
  ref: { targetKind: "type" | "module" | "method"; target: string; receiver?: string; enclosingTypeId: string; enclosingMethodId: string }
): { targetId: string; external?: string; reason: string } {
  const target = ref.target.trim().replace(/^['"]|['"]$/g, "");

  if (ref.targetKind === "module") {
    const first = index.matchModuleSuffix(target.startsWith("?suffix:") ? target.slice(8) : target)[0];
    if (first) return { targetId: moduleNodeId(first), reason: `module ${first}` };
    return { targetId: `ext:${target || "unknown"}`, external: target || "unknown", reason: `module ${target} is external` };
  }

  if (ref.targetKind === "type") {
    const types = resolveTypeCandidates(file, index, target);
    const first = types[0];
    if (first) return { targetId: first, reason: `type ${first}` };
    const scoped = file.scopeTypes?.get(target);
    if (scoped) {
      const external = externalPackageOf(file, index, scoped);
      if (external) return { targetId: `ext:${external}`, external, reason: `type ${target} is external` };
    }
    return { targetId: `__reflect__:${target}`, reason: `type ${target} not found` };
  }

  // Method lookup: resolve the receiver, then find the method by name.
  const receiver = resolveReceiver(file, index, ref.receiver ?? null, ref.enclosingTypeId, ref.enclosingMethodId);
  if (receiver.external) {
    return { targetId: `ext:${receiver.external}`, external: receiver.external, reason: receiver.reason };
  }
  for (const typeId of receiver.types) {
    const method = findInherited(index, typeId, target)[0];
    if (method) return { targetId: method.id, reason: `${target} on ${typeId}` };
  }
  for (const moduleId of receiver.moduleIds) {
    const member = resolveModuleMember(index, moduleId, target);
    if (member) return { targetId: member, reason: `${target} exported by ${moduleId}` };
  }
  const candidate = resolveTypeCandidates(file, index, target)[0];
  if (candidate) return { targetId: candidate, reason: `type ${target}` };
  return { targetId: `__reflect__:${target}`, reason: `method ${target} not found` };
}

/** Resolve an injection's declared type to a type id or external package. */
export function resolveInjectionTarget(
  file: ParsedFile,
  index: TypeIndex,
  typeText: string
): { targetId: string; external?: string } | null {
  const text = normalizeTypeText(typeText);
  if (!text) return null;
  const first = resolveTypeCandidates(file, index, typeText)[0];
  if (first) return { targetId: first };
  const external = externalPackageOf(file, index, text);
  if (external) return { targetId: `ext:${external}`, external };
  // Token-based injections (`@Inject("repo")`) land on an unknown node so the
  // graph still records that a dependency is supplied at run time.
  return { targetId: `__inject__:${text}` };
}

/** Resolve a route registration to the handler method node id. */
export function resolveRouteHandler(file: ParsedFile, index: TypeIndex, handlerName: string, moduleId: string): string | null {
  const moduleTypeId = moduleNodeId(moduleId);
  const direct = findMethodsNamed(index, moduleTypeId, handlerName)[0];
  if (direct) return direct.id;
  const inFile = file.methods.find((m) => m.name === handlerName);
  if (inFile) return inFile.id;
  for (const type of file.types) {
    const method = findMethodsNamed(index, type.id, handlerName)[0];
    if (method) return method.id;
  }
  const scoped = file.scopeTypes?.get(handlerName);
  if (scoped) {
    const firstType = resolveTypeCandidates(file, index, scoped)[0];
    if (firstType) {
      const method = findInherited(index, firstType, handlerName)[0];
      if (method) return method.id;
    }
    const moduleCandidate = index.resolveModuleId(scoped.split(".").slice(0, -1).join(".") || scoped);
    if (moduleCandidate) {
      const member = resolveModuleMember(index, moduleCandidate, handlerName);
      if (member) return member;
    }
  }
  const moduleTypes = file.types.filter((t) => t.id.startsWith(moduleTypeId));
  for (const type of moduleTypes) {
    const method = findMethodsNamed(index, type.id, handlerName)[0];
    if (method) return method.id;
  }
  return null;
}

export { resolveScopeValue };
