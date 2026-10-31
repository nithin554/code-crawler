import fs from "node:fs";
import path from "node:path";

/**
 * Path-alias rules derived from `tsconfig.json`.
 *
 * A monorepo almost never imports through relative paths. `@/orders/service` and
 * `@app/db` are resolved by the compiler from `compilerOptions.paths`, and a crawler
 * that ignores them records every such import as external — the graph then claims
 * the code is out of tree when the file is sitting right there.
 *
 * `paths` maps a pattern to a list of substitutions, so reading it means joining a
 * specifier's wildcard tail onto each target in order. The compiler takes the first
 * target whose file exists; a single-file parse cannot know that, so every candidate
 * is returned and the caller records the first-declared one — which is what `paths`
 * lists source before build output for anyway.
 */

/** One `paths` entry, with its target already resolved to a project-root path. */
export interface AliasRule {
  /** Specifier prefix before the wildcard, e.g. `@/` for pattern `@/*`. */
  prefix: string;
  /** Specifier suffix after the wildcard, e.g. `/index` for pattern `@/*\/index`. */
  suffix: string;
  /** Target templates, project-root-relative, each possibly containing `*`. */
  targets: string[];
  /** False for a wildcard-free pattern, which must match the specifier exactly. */
  wildcard: boolean;
}

/** Files consulted for aliases, most specific first. */
const TSCONFIG_FILES = ["tsconfig.json", "jsconfig.json"];
const MAX_EXTENDS_DEPTH = 8;

interface RawTsconfig {
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
  extends?: unknown;
}

function readJson(file: string): RawTsconfig | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as RawTsconfig;
  } catch {
    // A tsconfig with comments is JSON5, not JSON. Aliases are a bonus, never a
    // reason to fail a crawl, so an unreadable file means "no aliases".
    return null;
  }
}

function extendsTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Resolve an `extends` entry to a file path: relative, or a node_modules package. */
function resolveExtends(fromDir: string, specifier: string): string | null {
  const candidate = path.resolve(fromDir, specifier);
  const withExtension = [
    candidate,
    `${candidate}.json`,
    path.join(candidate, "tsconfig.json"),
  ].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (withExtension) return withExtension;
  // Package extends (`"extends": "@tsconfig/node22/tsconfig.json"`) walks out of the
  // project root, so it is deliberately not followed: the base config's paths would
  // be about a different tree, and guessing a node_modules layout buys little.
  return null;
}

/**
 * Collect `compilerOptions` from a tsconfig and its `extends` chain.
 *
 * Later configs win, matching the compiler: a base config's `paths` are replaced
 * wholesale rather than merged with the child's.
 */
function collectCompilerOptions(
  file: string,
  depth = 0,
  seen = new Set<string>()
): { baseUrl?: string; paths?: Record<string, unknown>; dir: string } {
  const dir = path.dirname(file);
  const json = readJson(file);
  if (!json || depth > MAX_EXTENDS_DEPTH || seen.has(file)) return { dir };
  seen.add(file);

  const inherited: { baseUrl?: string; paths?: Record<string, unknown>; dir: string }[] = [];
  for (const target of extendsTargets(json.extends)) {
    const resolved = resolveExtends(dir, target);
    if (!resolved) continue;
    inherited.push(collectCompilerOptions(resolved, depth + 1, seen));
  }

  const own = json.compilerOptions;
  const baseUrlRaw = typeof own?.baseUrl === "string" ? own.baseUrl : undefined;
  const pathsRaw =
    own?.paths !== null && typeof own?.paths === "object" && !Array.isArray(own.paths)
      ? (own.paths as Record<string, unknown>)
      : undefined;

  // A relative baseUrl is relative to the file that declared it, not to the project
  // root — a shared `tsconfig.base.json` one directory up anchors differently.
  const merged = inherited.reduce<{ baseUrl?: string; paths?: Record<string, unknown> }>(
    (acc, config) => ({
      baseUrl: config.baseUrl ?? acc.baseUrl,
      paths: config.paths ?? acc.paths,
    }),
    {}
  );
  if (baseUrlRaw !== undefined) merged.baseUrl = path.resolve(dir, baseUrlRaw);
  if (pathsRaw !== undefined) merged.paths = pathsRaw;

  return { ...merged, dir };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Alias rules from the project's `tsconfig.json` / `jsconfig.json`.
 *
 * Targets come back project-root-relative (and posix-separated) so the parser can
 * turn them into module ids without doing filesystem work. `baseUrl` alone becomes a
 * rule too: bare specifiers resolving under it is the other half of how `paths`-less
 * monorepos import.
 */
export function readTsconfigAliases(projectRoot: string): AliasRule[] {
  const configFile = TSCONFIG_FILES.map((name) => path.join(projectRoot, name)).find((p) =>
    fs.existsSync(p)
  );
  if (!configFile) return [];

  const { baseUrl, paths } = collectCompilerOptions(configFile);
  const root = path.resolve(projectRoot);
  const relativeTarget = (target: string): string => {
    const absolute = path.isAbsolute(target) ? target : path.resolve(baseUrl ?? root, target);
    return toPosix(path.relative(root, absolute));
  };

  const rules: AliasRule[] = [];
  for (const [pattern, value] of Object.entries(paths ?? {})) {
    if (typeof pattern !== "string" || !Array.isArray(value)) continue;
    const targets = value.filter((v): v is string => typeof v === "string").map(relativeTarget);
    if (targets.length === 0) continue;
    const star = pattern.indexOf("*");
    rules.push({
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? "" : pattern.slice(star + 1),
      targets,
      wildcard: star !== -1,
    });
  }

  // Longest prefix first so `@app/*` wins over a broader `@*`.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return rules;
}

/**
 * Project-root-relative targets for `specifier`, or `null` when no rule applies.
 *
 * Every target is returned so a caller can pick the one that exists on disk;
 * callers that cannot check use the first, which is the declared preference order.
 */
export function matchAlias(rules: readonly AliasRule[], specifier: string): string[] | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  for (const rule of rules) {
    if (!rule.wildcard) {
      // `"lodash": ["vendor/lodash"]` maps that one name; `lodash/debounce` is a
      // different module and must stay external.
      if (specifier === rule.prefix) return [...rule.targets];
      continue;
    }
    if (!specifier.startsWith(rule.prefix)) continue;
    if (rule.suffix && !specifier.endsWith(rule.suffix)) continue;
    if (specifier.length < rule.prefix.length + rule.suffix.length) continue;
    const tail = specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length);
    return rule.targets.map((target) => fillWildcard(target, tail));
  }
  return null;
}

/**
 * Substitute the single `*` in a target with the specifier's wildcard tail.
 *
 * Slicing rather than `replace("*", …)` states the contract: a `paths` target holds at
 * most one wildcard, at a known position, and any later `*` is a literal character.
 */
function fillWildcard(target: string, tail: string): string {
  const star = target.indexOf("*");
  if (star === -1) return target;
  return target.slice(0, star) + tail + target.slice(star + 1);
}

/**
 * Stable fingerprint of the alias rules, for cache invalidation: editing
 * `tsconfig.json` must re-parse files whose imports were resolved by the old rules.
 */
export function aliasSignature(rules: readonly AliasRule[]): string {
  return rules
    .map((r) => `${r.prefix}${r.suffix}=>${r.targets.join(",")}`)
    .sort()
    .join(";");
}
