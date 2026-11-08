/**
 * Compact projection for tool responses.
 *
 * A projected symbol reference costs about 150 characters:
 * `{"id":"method:pkg.Type#m:12","qualifiedName":"pkg.Type#m","name":"m","kind":"method","filePath":"src/Type.java"}`.
 * A deep trace repeats that object for every step, so the payload is dominated
 * by framing rather than by the answer. Compact mode keeps the answer and drops
 * the framing: every symbol reference becomes its fully-qualified name, which
 * already encodes both the owner and the member.
 *
 * The projection is structural, not per-tool, so it applies uniformly to every
 * response without each tool having to describe a second output shape. Callers
 * that need `kind` or `filePath` back either resolve the qualified name with
 * `get_node` or call the same tool without `compact`.
 *
 * Measured on the dynamic-dispatch fixture, compact cuts response size by 61%
 * (`get_callers`) to 83% (`search_symbols`); the heavier the payload leans on
 * repeated references and absolute paths, the more it saves.
 */

/** A symbol reference as the tool layer builds it: either the five keys from `ref` or the four `search_symbols` keys. */
export interface CompactableRef {
  id: string;
  qualifiedName: string;
  kind: string;
  name?: string;
  filePath?: string | null;
}

/**
 * True only for an object shaped like a projected symbol reference.
 *
 * The test is the identity triple — `id`, `qualifiedName`, `kind` — not the
 * full five-key shape, because `search_symbols` omits `name` for packages. An
 * unrelated payload that happens to carry a `kind` (an edge row, a schema
 * description) lacks a symbol id, so it is left untouched.
 */
export function looksLikeSymbolRef(value: unknown): value is CompactableRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.qualifiedName === "string" &&
    typeof candidate.kind === "string"
  );
}

/**
 * Recursively replace symbol references with their qualified names.
 *
 * Arrays and plain objects are walked; every other value is returned as-is. The
 * function never drops a key, so the shape of the response is otherwise
 * unchanged and a caller can still read `count`, `page`, `path`, `line` and the
 * fields that are not symbol references.
 */
export function compactify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compactify(item));
  if (looksLikeSymbolRef(value)) return value.qualifiedName;
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = compactify(item);
    return result;
  }
  return value;
}
