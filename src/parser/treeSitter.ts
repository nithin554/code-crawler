import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Shared tree-sitter setup: WASM runtime init, grammar loading, and CST walk
 * helpers. The WASM runtime keeps the server fully portable (no native build
 * step required by end users).
 */

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;

/** Initialize the web-tree-sitter WASM runtime exactly once. */
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    const wasmPath = path.join(
      path.dirname(require.resolve("web-tree-sitter")),
      "web-tree-sitter.wasm"
    );
    initPromise = Parser.init({ locateFile: () => wasmPath }).then(() => undefined);
  }
  return initPromise;
}

const grammarCache = new Map<string, Promise<Language>>();

/** Locate the package root directory containing its package.json. */
function packageRoot(packageName: string): string {
  const mainPath = require.resolve(packageName);
  let dir = path.dirname(mainPath);
  for (let i = 0; i < 10; i++) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string };
        if (pkg.name === packageName) return dir;
      } catch {
        // ignore malformed package.json and keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: dirname of the resolved main entry.
  return path.dirname(mainPath);
}

/**
 * Load a grammar's compiled WASM from its npm package and return a tree-sitter
 * Language. Cached across calls.
 */
export function loadGrammar(packageName: string, wasmFileName: string): Promise<Language> {
  const cached = grammarCache.get(packageName);
  if (cached) return cached;

  const promise = (async () => {
    await initTreeSitter();
    const wasmPath = path.join(packageRoot(packageName), wasmFileName);
    return Language.load(fs.readFileSync(wasmPath));
  })();

  grammarCache.set(packageName, promise);
  return promise;
}

/** Create a parser bound to the given language. */
export function createParser(lang: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export type TSNode = import("web-tree-sitter").Node;

/** First named child of a given type, or null. */
export function childOfType(node: TSNode, type: string): TSNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/** All named children of a given type. */
export function childrenOfType(node: TSNode, type: string): TSNode[] {
  return node.namedChildren.filter((c) => c.type === type);
}

/** Field child, or null. */
export function fieldChild(node: TSNode, field: string): TSNode | null {
  return node.childForFieldName(field);
}

/** Walk the tree depth-first, invoking `visit` on every named node. */
export function walk(node: TSNode, visit: (n: TSNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walk(child, visit);
  }
}

/**
 * Strip generics, array dimensions and ellipsis from a raw type text,
 * returning the base type usable for symbol lookup.
 *   `List<String>`      -> `List`
 *   `java.util.List<T>` -> `java.util.List`
 *   `int[]`             -> `int`
 *   `String...`         -> `String`
 */
export function baseTypeName(raw: string): string {
  let t = raw.trim();
  // strip type arguments (generic <...>)
  while (t.includes("<")) {
    const open = t.indexOf("<");
    const close = t.lastIndexOf(">");
    if (close < open) break;
    t = (t.slice(0, open) + t.slice(close + 1)).trim();
  }
  // strip array suffix
  t = t.replace(/\[\s*\]$/, "");
  // strip varargs ellipsis
  t = t.replace(/\.\.\.$/, "");
  return t.trim();
}
