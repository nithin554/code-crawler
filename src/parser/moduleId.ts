import path from "node:path";

/**
 * Module identity for languages without packages (Python, TypeScript).
 *
 * A module is the language's file-level namespace:
 *   - Python:     `app/services/order.py`      -> `app.services.order`
 *                 `app/services/__init__.py`   -> `app.services`
 *   - TypeScript: `src/services/order.ts`      -> `src.services.order`
 *                 `src/services/index.ts`      -> `src.services`
 *
 * Module nodes use a `module:` id prefix so they can never collide with a
 * Java package node (which uses the bare dotted package name).
 */

export const MODULE_ID_PREFIX = "module:";

/** Scope value suffix marking "this binding is the module's default export". */
export const DEFAULT_EXPORT_SUFFIX = ".#default";

export function moduleNodeId(moduleId: string): string {
  return `${MODULE_ID_PREFIX}${moduleId}`;
}

export function isModuleNodeId(id: string): boolean {
  return id.startsWith(MODULE_ID_PREFIX);
}

/** Strip a module-node prefix, if present. */
export function unwrapModuleNodeId(id: string): string {
  return isModuleNodeId(id) ? id.slice(MODULE_ID_PREFIX.length) : id;
}

export function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** Path relative to the project root, falling back to the basename. */
export function relativeModulePath(filePath: string, projectRoot?: string): string {
  if (!projectRoot) return toPosix(path.basename(filePath));
  const rel = toPosix(path.relative(projectRoot, filePath));
  return rel.startsWith("../") || rel === ".." ? toPosix(path.basename(filePath)) : rel;
}

function stripExtension(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const slash = rel.lastIndexOf("/");
  return dot > slash ? rel.slice(0, dot) : rel;
}

export function pythonModuleId(filePath: string, projectRoot?: string): string {
  const relative = stripExtension(relativeModulePath(filePath, projectRoot));
  const parts = relative.split("/").filter(Boolean);
  if (parts.length > 0 && parts[parts.length - 1] === "__init__") parts.pop();
  return parts.join(".") || "__root__";
}

export function tsModuleId(filePath: string, projectRoot?: string): string {
  const relative = stripExtension(relativeModulePath(filePath, projectRoot)).replace(/\.d$/, "");
  const parts = relative.split("/").filter(Boolean);
  if (
    parts.length > 1 &&
    (parts[parts.length - 1] === "index" || parts[parts.length - 1] === "mod")
  ) {
    parts.pop();
  }
  return parts.join(".") || "__root__";
}

/**
 * Resolve a relative TS/JS specifier against the importing module.
 * `currentModuleId` is the importing file's module id (including its own
 * segment), so the file segment is dropped before walking `..`.
 */
export function resolveRelativeModule(currentModuleId: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = currentModuleId.split(".").filter(Boolean);
  base.pop();
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.join(".");
}

/**
 * Resolve a Python relative import (`from ..services import order`).
 * `currentModuleId` excludes the file segment for `__init__.py` files.
 */
export function resolvePythonRelative(
  currentModuleId: string,
  isPackageFile: boolean,
  level: number,
  moduleText: string
): string {
  const base = currentModuleId.split(".").filter(Boolean);
  if (!isPackageFile) base.pop();
  const climb = Math.max(0, level - 1);
  for (let i = 0; i < climb; i++) base.pop();
  if (moduleText) base.push(...moduleText.split(".").filter(Boolean));
  return base.join(".");
}
