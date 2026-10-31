import type { ParsedFile } from "../parser/language.js";
import { moduleResolver } from "./genericResolver.js";
import { javaResolver } from "./javaResolver.js";
import type { ResolvedCall, Resolver, ResolverCapability, TypeIndex } from "./types.js";

/**
 * Call resolvers, keyed by the name a language descriptor declares. Adding a
 * language means adding a descriptor and (if it needs new resolution rules) one
 * entry here — no edits to `crawler.ts` or to any existing language module.
 */
const registry = new Map<string, Resolver>([
  [javaResolver.name, javaResolver],
  [moduleResolver.name, moduleResolver],
]);

/** The resolver used when a language declares no specialised one. */
export const DEFAULT_RESOLVER = moduleResolver.name;

export function getResolver(name: string): Resolver | undefined {
  return registry.get(name);
}

export function listResolvers(): Resolver[] {
  return [...registry.values()];
}

export function resolverNames(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve a parsed file's calls with the given resolver, falling back to the
 * default when the name is unknown so an unregistered language degrades to
 * module resolution instead of failing the whole crawl.
 */
export function resolveFileWith(
  resolverName: string,
  parsed: ParsedFile,
  index: TypeIndex
): ResolvedCall[] {
  const resolver = getResolver(resolverName) ?? moduleResolver;
  return resolver.resolveFile(parsed, index);
}

/** Capabilities a language buys, given its descriptor's resolver name. */
export function capabilitiesOf(resolverName: string): readonly ResolverCapability[] {
  return (getResolver(resolverName) ?? moduleResolver).capabilities;
}
