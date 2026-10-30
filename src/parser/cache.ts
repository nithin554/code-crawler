import type { ParsedFile } from "./language.js";

/**
 * Serialisation for the per-file parse cache.
 *
 * `ParsedFile` carries `Map` instances, which `JSON.stringify` silently
 * flattens to `{}`. Packing converts them to plain objects so an unchanged
 * file can be replayed from the crawl manifest instead of being parsed again.
 *
 * Only plain data is stored: nothing here may grow a function, class instance
 * or cyclic reference, or the cache becomes lossy.
 */

interface PackedParsedFile
  extends Omit<
    ParsedFile,
    "localsByMethod" | "scopeTypes" | "scopeModules" | "externalModules"
  > {
  localsByMethod: Record<string, Record<string, string>>;
  scopeTypes?: Record<string, string>;
  scopeModules?: Record<string, string>;
  externalModules?: Record<string, string>;
  /** Java files expose a simple-name -> FQN map (usually `scopeTypes`). */
  typeByName?: Record<string, string>;
}

/** A `ParsedFile` that a language may extend with extra maps. */
type WithTypeByName = ParsedFile & { typeByName?: Map<string, string> };

function mapToRecord<V>(map: Map<string, V> | undefined): Record<string, V> | undefined {
  if (!map) return undefined;
  const out: Record<string, V> = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

function recordToMap<V>(record: Record<string, V> | undefined): Map<string, V> {
  const out = new Map<string, V>();
  for (const [key, value] of Object.entries(record ?? {})) out.set(key, value);
  return out;
}

/** Value equality for two optional string records. */
function sameRecord(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/** Convert a parsed file into a JSON-safe value. */
export function packParsedFile(parsed: ParsedFile): PackedParsedFile {
  const locals: Record<string, Record<string, string>> = {};
  for (const [methodId, localsByMethod] of parsed.localsByMethod) {
    locals[methodId] = mapToRecord(localsByMethod) ?? {};
  }
  return {
    ...parsed,
    localsByMethod: locals,
    scopeTypes: mapToRecord(parsed.scopeTypes),
    scopeModules: mapToRecord(parsed.scopeModules),
    externalModules: mapToRecord(parsed.externalModules),
    typeByName: mapToRecord((parsed as WithTypeByName).typeByName),
  };
}

/** Restore a parsed file written by {@link packParsedFile}. */
export function unpackParsedFile(packed: PackedParsedFile): ParsedFile {
  const localsByMethod = new Map<string, Map<string, string>>();
  for (const [methodId, locals] of Object.entries(packed.localsByMethod ?? {})) {
    localsByMethod.set(methodId, recordToMap(locals));
  }
  const scopeTypes = recordToMap(packed.scopeTypes);
  const parsed: ParsedFile = {
    ...packed,
    localsByMethod,
    scopeTypes,
    scopeModules: recordToMap(packed.scopeModules),
    externalModules: recordToMap(packed.externalModules),
  };
  if (packed.typeByName) {
    // Java sets `typeByName` to the very same map as `scopeTypes`; keep the
    // aliasing so the resolver sees the object shape a fresh parse produces.
    (parsed as WithTypeByName).typeByName = sameRecord(packed.typeByName, packed.scopeTypes)
      ? scopeTypes
      : recordToMap(packed.typeByName);
  }
  return parsed;
}

/** Serialise a parsed file for storage in the crawl manifest. */
export function encodeParsedFile(parsed: ParsedFile): string {
  return JSON.stringify(packParsedFile(parsed));
}

/** Decode a manifest summary; returns null when the payload is unusable. */
export function decodeParsedFile(json: string | null): ParsedFile | null {
  if (!json) return null;
  try {
    const packed = JSON.parse(json) as PackedParsedFile;
    if (!packed || typeof packed.filePath !== "string") return null;
    return unpackParsedFile(packed);
  } catch {
    return null;
  }
}
