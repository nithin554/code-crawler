/**
 * Method-id helpers.
 *
 * A method node id is `Type#name`, and the first declaration of each name keeps
 * that bare form. Later overloads carry their parameter types — `Type#name(int)`,
 * `Type#<init>(int,String)` — so every declaration stays individually
 * addressable. These helpers read such ids without assuming the suffix is
 * absent.
 */

/** Id without its overload signature: `Type#f(int)` -> `Type#f`. */
export function baseMethodId(id: string): string {
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  const paren = id.indexOf("(", hash);
  return paren < 0 ? id : id.slice(0, paren);
}

/** True when the id names a constructor, with or without an overload signature. */
export function isConstructorMethodId(id: string): boolean {
  return baseMethodId(id).endsWith("#<init>");
}

/** Qualified type that declares the method: `com.acme.Foo#f(int)` -> `com.acme.Foo`. */
export function ownerTypeOfMethodId(id: string): string {
  const base = baseMethodId(id);
  const hash = base.lastIndexOf("#");
  return hash < 0 ? base : base.slice(0, hash);
}
