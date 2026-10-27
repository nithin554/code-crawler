import type { FieldInfo, MethodInfo, ParsedFile } from "../parser/language.js";
import { DEFAULT_EXPORT_SUFFIX, MODULE_ID_PREFIX, moduleNodeId, unwrapModuleNodeId } from "../parser/moduleId.js";
import type { TypeIndex } from "./types.js";

/**
 * Language-neutral helpers shared by the Java and generic resolvers:
 * type-text normalization, scope/import resolution, receiver inference and
 * method lookup. Keeping them here means the Python/TypeScript resolver only
 * has to encode the language's dispatch rules.
 */

/** Globals that never live in the project (browser/Node/JS built-ins). */
const GLOBAL_OBJECTS = new Set([
  "console",
  "process",
  "global",
  "globalThis",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "Math",
  "JSON",
  "Object",
  "Array",
  "Promise",
  "Date",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "RegExp",
  "Error",
  "Reflect",
  "Proxy",
  "Intl",
  "Buffer",
  "URL",
  "URLSearchParams",
  "fetch",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "structuredClone",
  "queueMicrotask",
]);

/** Python builtins that are not project code. */
const PYTHON_BUILTINS = new Set([
  "print",
  "len",
  "range",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "reversed",
  "sum",
  "min",
  "max",
  "abs",
  "any",
  "all",
  "isinstance",
  "issubclass",
  "getattr",
  "setattr",
  "hasattr",
  "delattr",
  "open",
  "input",
  "repr",
  "id",
  "hash",
  "iter",
  "next",
  "dir",
  "vars",
  "callable",
  "round",
  "format",
  "type",
  "super",
  "object",
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
  "Exception",
  "ValueError",
  "TypeError",
  "KeyError",
  "RuntimeError",
  "NotImplementedError",
]);

/** Wrappers whose inner type is the interesting one for dispatch. */
const TRANSPARENT_WRAPPERS = new Set([
  "Optional",
  "Awaitable",
  "Coroutine",
  "Promise",
  "PromiseLike",
  "List",
  "Array",
  "ReadonlyArray",
  "Readonly",
  "Partial",
  "Required",
  "Set",
  "FrozenSet",
  "Sequence",
  "Iterable",
  "Iterator",
  "Generator",
  "AsyncIterable",
  "Collection",
  "Type",
  "ClassVar",
  "Ref",
  "RefObject",
  "Signal",
  "ComputedRef",
  "Observable",
  "Future",
  "Task",
  "Repository",
  "Maybe",
  "Annotated",
  "Final",
]);

/** Split `text` on top-level occurrences of `separator`. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(current);
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Strip TS/Python type syntax down to a dispatchable type name. */
export function normalizeTypeText(raw: string): string {
  let text = (raw ?? "").trim();
  if (!text) return "";
  text = text.replace(/^->\s*/, "").replace(/^:\s*/, "");
  text = text.replace(/^(readonly|typeof|final|val|var)\s+/i, "");
  text = splitTopLevel(text, "&").slice(0, 1).join("&").trim();
  const union = splitTopLevel(text, "|").map((p) => p.trim()).filter((p) => p && !/^(null|undefined|None|nil)$/i.test(p));
  text = union[0] ?? "";
  text = text.replace(/\[\s*\]$/, "");
  text = text.replace(/^["']|["']$/g, "");
  const wrapper = /^([A-Za-z_$][\w$.]*)\s*[<[[](.*)[>\]]\s*$/.exec(text);
  if (wrapper) {
    const base = (wrapper[1] ?? "").split(".").pop() ?? "";
    if (TRANSPARENT_WRAPPERS.has(base)) {
      const inner = splitTopLevel(wrapper[2] ?? "", ",")[0] ?? "";
      return normalizeTypeText(inner);
    }
    return base;
  }
  return text.replace(/\s+/g, "");
}

/** The enclosing type id plus all resolvable ancestors (breadth-first). */
export function enclosingChain(index: TypeIndex, typeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = [typeId];
  for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      for (const parentName of index.parentsByFqn.get(current) ?? []) {
        for (const parent of index.resolveType(parentName)) next.push(parent);
      }
    }
    frontier = next;
  }
  return out;
}

/** Owning module id of a type or module-level function id, if any. */
export function moduleIdOf(typeId: string): string | null {
  if (typeId.startsWith(MODULE_ID_PREFIX)) {
    return unwrapModuleNodeId(typeId.split("#")[0] ?? "") ?? null;
  }
  return null;
}

/** Resolve an imported binding (scope value) to type or module node ids. */
export function resolveScopeValue(file: ParsedFile, index: TypeIndex, value: string, depth = 0): string[] {
  if (!value || depth > 5) return [];
  if (value.endsWith(DEFAULT_EXPORT_SUFFIX)) {
    const moduleId = index.resolveModuleId(value.slice(0, -DEFAULT_EXPORT_SUFFIX.length));
    if (!moduleId) return [];
    const target = index.defaultExports.get(moduleId);
    return target ? [target] : [moduleNodeId(moduleId)];
  }
  if (value.startsWith("?suffix:")) {
    const first = index.matchModuleSuffix(value.slice("?suffix:".length))[0];
    return first ? [moduleNodeId(first)] : [];
  }
  if (index.kindByFqn.has(value)) return [value];
  if (index.moduleExists(value)) return [moduleNodeId(value)];
  const scopedType = file.scopeTypes?.get(value);
  if (scopedType && scopedType !== value) return resolveScopeValue(file, index, scopedType, depth + 1);
  const scopedModule = file.scopeModules?.get(value);
  if (scopedModule) {
    const matches = scopedModule.startsWith("?suffix:")
      ? index.matchModuleSuffix(scopedModule.slice("?suffix:".length))
      : [];
    const moduleId = matches[0] ?? index.resolveModuleId(scopedModule);
    return moduleId ? [moduleNodeId(moduleId)] : [];
  }
  const external = file.externalModules?.get(value);
  if (external) return [];
  return [];
}

/** True when the dotted path names a module declared in the project. */
export function belongsToProject(index: TypeIndex, dotted: string): boolean {
  const parts = dotted.split(".").filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(".");
    if (index.moduleExists(prefix)) return true;
    if (index.resolveModuleId(prefix)) return true;
  }
  return false;
}

/** External package for an unresolved dotted reference (`fastapi.Depends` -> `fastapi`). */
export function externalPackageOf(file: ParsedFile, index: TypeIndex, dotted: string): string | null {
  const root = dotted.split(".")[0] ?? "";
  const explicit = file.externalModules?.get(root) ?? file.externalModules?.get(dotted);
  if (explicit) return explicit;
  if (!root || GLOBAL_OBJECTS.has(root)) return root || null;
  // `my_list.append` on a container value is stdlib, not a package named after
  // its type.
  if (file.language === "python" && isBuiltinTypeName(root)) return "builtins";
  if (belongsToProject(index, dotted)) return null;
  return root;
}

/** Resolve a raw type name to candidate type ids declared in the project. */
export function resolveTypeCandidates(file: ParsedFile, index: TypeIndex, raw: string, depth = 0): string[] {
  if (!raw || depth > 4) return [];
  const text = normalizeTypeText(raw);
  if (!text) return [];
  if (index.kindByFqn.has(text)) return [text];

  const scoped = file.scopeTypes?.get(text);
  if (scoped && scoped !== text) {
    const resolved = resolveScopeValue(file, index, scoped, depth + 1).filter((id) => index.kindByFqn.has(id));
    if (resolved.length > 0) return resolved;
  }

  if (text.includes(".")) {
    const tail = text.split(".").pop()!;
    // Module node ids (`module:app.service`) are namespaces, not types, so a
    // receiver named `service` must not match one by suffix.
    const suffixMatches = [...index.kindByFqn.keys()].filter(
      (id) => index.kindByFqn.get(id) !== "module" && (id === text || id.endsWith(`.${text}`))
    );
    if (suffixMatches.length > 0) return suffixMatches;
    const scopedTail = file.scopeTypes?.get(tail);
    if (scopedTail && scopedTail !== tail) {
      const resolved = resolveScopeValue(file, index, scopedTail, depth + 1).filter((id) => index.kindByFqn.has(id));
      if (resolved.length > 0) return resolved;
    }
  }

  const simple = text.split(".").pop()!;
  if (file.moduleId) {
    const local = `${file.moduleId}.${simple}`;
    if (index.kindByFqn.has(local)) return [local];
  }
  const byName = (index.typesBySimpleName.get(simple) ?? []).filter(
    (id) => index.kindByFqn.get(id) !== "module"
  );
  return byName;
}

/** Find a field declared on `typeId` or any resolvable ancestor. */
export function findField(index: TypeIndex, typeId: string, name: string): FieldInfo | undefined {
  for (const candidate of enclosingChain(index, typeId)) {
    const field = (index.fieldsByFqn.get(candidate) ?? []).find((f) => f.name === name);
    if (field) return field;
  }
  return undefined;
}

/** Methods declared directly on a type (or module) with the given name. */
export function findMethodsNamed(index: TypeIndex, typeId: string, name: string): MethodInfo[] {
  return (index.methodsByFqn.get(typeId) ?? []).filter((m) => m.name === name);
}

/** Methods named `name` on `typeId` or its ancestors, nearest declaration first. */
export function findInherited(index: TypeIndex, typeId: string, name: string): MethodInfo[] {
  for (const candidate of enclosingChain(index, typeId)) {
    const found = findMethodsNamed(index, candidate, name);
    if (found.length > 0) return found;
  }
  return [];
}

/** Pick the overload whose arity best matches the call site. */
export function pickOverload(methods: MethodInfo[], argCount: number): MethodInfo | undefined {
  if (methods.length === 0) return undefined;
  if (methods.length === 1) return methods[0];
  const exact = methods.find((m) => m.params.length === argCount);
  if (exact) return exact;
  const variadic = methods.find((m) => m.params.length < argCount);
  if (variadic) return variadic;
  return methods.slice().sort((a, b) => a.params.length - b.params.length)[0];
}

/** True when a bare name is a Python builtin (external code). */
export function isPythonBuiltin(name: string): boolean {
  return PYTHON_BUILTINS.has(name);
}

/** Container/primitive type names that carry no project identity. */
const BUILTIN_TYPE_NAMES = new Set([
  ...Array.from(PYTHON_BUILTINS),
  "str",
  "int",
  "float",
  "bool",
  "bytes",
  "bytearray",
  "complex",
  "list",
  "dict",
  "set",
  "tuple",
  "frozenset",
  "object",
  "None",
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "void",
  "never",
  "symbol",
  "bigint",
  "null",
  "undefined",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Record",
]);

/** True when a type name is a language primitive or container, not a project type. */
export function isBuiltinTypeName(raw: string): boolean {
  const text = normalizeTypeText(raw);
  if (!text) return false;
  const base = text.split(".").pop() ?? text;
  return BUILTIN_TYPE_NAMES.has(text) || BUILTIN_TYPE_NAMES.has(base);
}

/** True when a bare name is a JS/Node/browser global (external code). */
export function isGlobalObject(name: string): boolean {
  return GLOBAL_OBJECTS.has(name);
}

export interface ReceiverResolution {
  /** Candidate types, nearest first (the enclosing chain for `this`). */
  types: string[];
  /** Candidate modules (dotted module ids) the receiver points at. */
  moduleIds: string[];
  /** External package when the receiver escapes the crawled tree. */
  external?: string;
  /** Why the receiver resolved the way it did. */
  reason: string;
}

function splitReceiver(text: string): string[] {
  return splitTopLevel(text.replace(/\?\./g, "."), ".").map((p) => p.trim()).filter(Boolean);
}

/**
 * Infer what a call receiver refers to: a chain of types, one or more modules,
 * or external code. This is the heart of cross-language receiver inference.
 */
export function resolveReceiver(
  file: ParsedFile,
  index: TypeIndex,
  receiver: string | null,
  enclosingTypeId: string,
  enclosingMethodId: string
): ReceiverResolution {
  const enclosingTypes = enclosingChain(index, enclosingTypeId);
  const text = (receiver ?? "").trim();
  if (!text) {
    const own = moduleIdOf(enclosingTypeId);
    return { types: enclosingTypes, moduleIds: own ? [own] : [], reason: "implicit this/module scope" };
  }

  if (text === "this" || text === "self") {
    return { types: enclosingTypes, moduleIds: [], reason: `${text} resolves to the enclosing type` };
  }
  if (text === "cls" || text === "super" || text === "super()") {
    if (text === "cls") return { types: [enclosingTypeId], moduleIds: [], reason: "cls resolves to the enclosing class" };
    const parents: string[] = [];
    for (const parentName of index.parentsByFqn.get(enclosingTypeId) ?? []) {
      parents.push(...index.resolveType(parentName));
    }
    const types = parents.length > 0 ? parents : enclosingTypes.slice(1);
    return { types, moduleIds: [], reason: "super resolves to the parent type" };
  }

  if (text.startsWith("this.") || text.startsWith("self.")) {
    const path = text.replace(/^(this|self)\./, "");
    const rootName = splitReceiver(path)[0] ?? "";
    const rootField = findField(index, enclosingTypeId, rootName);
    if (rootField?.type) {
      const types = resolveTypeCandidates(file, index, rootField.type);
      if (types.length > 0) {
        return { types, moduleIds: [], reason: `field ${path} has type ${rootField.type}` };
      }
    }
    const scoped = resolveScopeValue(file, index, rootName);
    const scopedTypes = scoped.filter((id) => index.kindByFqn.has(id));
    if (scopedTypes.length > 0) return { types: scopedTypes, moduleIds: [], reason: `field ${path} is imported` };
  }

  if (text.startsWith("new ")) {
    const inner = resolveReceiver(file, index, text.slice(4), enclosingTypeId, enclosingMethodId);
    if (inner.types.length > 0) return { ...inner, reason: `constructed instance: ${inner.reason}` };
  }

  // Dotted paths (`service.repo`, `this.helper.client`) are walked segment by
  // segment so a field of a local's type stays typed instead of being
  // externalised by its root name.
  const pathSegments = splitReceiver(text);
  if (pathSegments.length > 1) {
    const rootResolution = resolveReceiver(file, index, pathSegments[0]!, enclosingTypeId, enclosingMethodId);
    let types = rootResolution.types;
    let external = rootResolution.external;
    let container = false;
    for (const segment of pathSegments.slice(1)) {
      if (external || types.length === 0) break;
      const next: string[] = [];
      for (const typeId of types) {
        const field = findField(index, typeId, segment);
        if (!field?.type) continue;
        if (isBuiltinTypeName(field.type)) {
          container = true;
          continue;
        }
        next.push(...resolveTypeCandidates(file, index, field.type));
      }
      types = next;
      if (types.length === 0 && container) external = "builtins";
    }
    if (types.length > 0) {
      return { types, moduleIds: [], reason: `field path ${text} (${rootResolution.reason})` };
    }
    if (container) {
      return { types: [], moduleIds: [], external: "builtins", reason: `${text} is a builtin container member` };
    }
    if (external && external !== text) {
      return { types: [], moduleIds: [], external, reason: `${text} resolves outside the project` };
    }
  }

  // A call used as a receiver: `getService().run()`.
  if (/^[A-Za-z_$][\w$.]*\(\)$/.test(text)) {
    const called = text.slice(0, -2);
    const name = called.split(".").pop()!;
    const typeIds = called.includes(".")
      ? enclosingTypes
      : [enclosingTypeId, ...(moduleIdOf(enclosingTypeId) ? [moduleNodeId(moduleIdOf(enclosingTypeId)!)] : [])];
    for (const typeId of typeIds) {
      const method = pickOverload(findInherited(index, typeId, name), 0);
      const returnType = method ? normalizeTypeText(method.returnType) : "";
      if (returnType) {
        const types = resolveTypeCandidates(file, index, returnType);
        if (types.length > 0) return { types, moduleIds: [], reason: `receiver is the result of ${name}()` };
      }
    }
  }

  const segments = splitReceiver(text);
  const root = segments[0] ?? "";
  const rest = segments.slice(1);

  const scopedModule = file.scopeModules?.get(root);
  if (scopedModule) {
    if (rest.length === 0) {
      const moduleId = index.resolveModuleId(scopedModule.replace("?suffix:", ""));
      if (moduleId) return { types: [], moduleIds: [moduleId], reason: `${root} is module ${moduleId}` };
      return { types: [], moduleIds: [], external: scopedModule, reason: `${root} is the external module ${scopedModule}` };
    }
    const direct = rest.join(".");
    const combined = index.matchModuleSuffix(`${scopedModule.replace("?suffix:", "")}.${direct}`)[0];
    if (combined) return { types: [], moduleIds: [combined], reason: `nested module ${combined}` };
    const moduleId = index.resolveModuleId(scopedModule.replace("?suffix:", ""));
    if (moduleId) return { types: [], moduleIds: [moduleId], reason: `${root} is module ${moduleId}` };
    return { types: [], moduleIds: [], external: scopedModule, reason: `${root} is the external module ${scopedModule}` };
  }

  const externalBinding = file.externalModules?.get(root);
  if (externalBinding) {
    return { types: [], moduleIds: [], external: externalBinding, reason: `${root} is imported from ${externalBinding}` };
  }

  const scopedType = file.scopeTypes?.get(root);
  if (scopedType) {
    const types = resolveTypeCandidates(file, index, scopedType);
    if (types.length > 0) return { types, moduleIds: [], reason: `${root} is imported type ${types[0] ?? scopedType}` };
    const symbolValue = file.scopeModules?.get(root) ?? scopedType;
    const moduleIds = resolveScopeValue(file, index, symbolValue).filter((id) => !index.kindByFqn.has(id));
    const firstModule = moduleIds[0];
    if (firstModule) {
      const moduleId = unwrapModuleNodeId(firstModule);
      // `import { service } from "./x"` where service is a module-level value.
      if (moduleId) return { types: [], moduleIds: [moduleId], reason: `${root} is a symbol exported by ${moduleId}` };
    }
    const external = externalPackageOf(file, index, scopedType);
    if (external) return { types: [], moduleIds: [], external, reason: `${root} comes from external package ${external}` };
  }

  const field = findField(index, enclosingTypeId, root);
  if (field?.type) {
    const types = resolveTypeCandidates(file, index, field.type);
    if (types.length > 0) return { types, moduleIds: [], reason: `field ${root} has type ${field.type}` };
  }

  const moduleId = moduleIdOf(enclosingTypeId);
  if (moduleId) {
    const moduleField = findField(index, moduleNodeId(moduleId), root);
    if (moduleField?.type) {
      const types = resolveTypeCandidates(file, index, moduleField.type);
      if (types.length > 0) return { types, moduleIds: [], reason: `module field ${root} has type ${moduleField.type}` };
    }
  }

  const local = file.localsByMethod.get(enclosingMethodId)?.get(root) ?? file.localsByMethod.get(enclosingMethodId)?.get(text);
  if (local) {
    const types = resolveTypeCandidates(file, index, local);
    if (types.length > 0) return { types, moduleIds: [], reason: `local ${root} has inferred type ${local}` };
    if (isBuiltinTypeName(local)) {
      return { types: [], moduleIds: [], external: "builtins", reason: `local ${root} is a builtin ${local}` };
    }
  }

  const asType = resolveTypeCandidates(file, index, text);
  if (asType.length > 0) {
    return { types: asType, moduleIds: [], reason: `${text} names a project type` };
  }

  if (rest.length > 0) {
    const nested = resolveTypeCandidates(file, index, rest.join("."));
    if (nested.length > 0) return { types: nested, moduleIds: [], reason: `nested type ${rest.join(".")}` };
  }

  if (isGlobalObject(root)) {
    return { types: [], moduleIds: [], external: root, reason: `${root} is a runtime global` };
  }

  // `self.unknownField`, `this.builder.x`: the receiver is the enclosing
  // instance, so an untyped member is unresolved project code, not external.
  if (root === "this" || root === "self" || root === "cls" || root === "super") {
    return { types: [], moduleIds: [], reason: `member ${text} of the enclosing type could not be typed` };
  }

  // `some_list.append` and friends: the receiver is a builtin container, so the
  // member lives in the standard library, not in a package called `list[str]`.
  if (isBuiltinTypeName(root)) {
    return { types: [], moduleIds: [], external: "builtins", reason: `${root} is a builtin container` };
  }

  const external = externalPackageOf(file, index, text);
  if (external && external !== text) {
    return { types: [], moduleIds: [], external, reason: `${root} resolves outside the project` };
  }

  return { types: [], moduleIds: [], reason: "receiver type could not be inferred" };
}

/**
 * Resolve a method node id inside a module: a module-level function first, then
 * a single matching method anywhere in the module (for `from x import f`).
 */
export function resolveModuleMember(index: TypeIndex, moduleId: string, name: string): string | null {
  const moduleTypeId = moduleNodeId(moduleId);
  const direct = findMethodsNamed(index, moduleTypeId, name);
  if (direct.length > 0) return direct[0]?.id ?? null;
  const matches: string[] = [];
  for (const [typeId, methods] of index.methodsByFqn) {
    if (typeId !== moduleTypeId && !typeId.startsWith(`${moduleId}.`)) continue;
    for (const method of methods) {
      if (method.name === name) matches.push(method.id);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
