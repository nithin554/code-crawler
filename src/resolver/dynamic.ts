import type { AnnotationInfo, MethodInfo, ParsedFile } from "../parser/language.js";
import type { GraphEdge } from "../graph/schema.js";
import type { TypeIndex } from "./types.js";

/**
 * Dynamic-behaviour enrichment.
 *
 * Static call graphs answer "what does the source say is called?". Runtime
 * behaviour differs in two important ways that this module approximates on top
 * of the static graph:
 *
 *  1. **Virtual dispatch** — a call to an interface/base-class method may run
 *     any override. `DYNAMIC_DISPATCH` edges connect the statically-declared
 *     target to every override found in the project.
 *  2. **Aspects and decorators** — AOP advice intercepts matched methods at
 *     runtime, and framework decorator annotations (transactional, cached,
 *     asynchronous, ...) change how a method executes. `ADVISES` edges connect
 *     advice methods to the methods their pointcuts match.
 *
 * The traversal layer can then follow both edge kinds, producing a static
 * approximation of runtime execution rather than just the literal source calls.
 */

/** Framework annotations that behave as runtime decorators. */
export const DECORATOR_ANNOTATIONS = new Set([
  "Transactional",
  "Cacheable",
  "CachePut",
  "CacheEvict",
  "Async",
  "Retryable",
  "Secured",
  "PreAuthorize",
  "RolesAllowed",
  "Timed",
  "Scheduled",
  "Loggable",
  "Measured",
  "RateLimit",
  "Idempotent",
  "Validated",
]);

/** True when an annotation/decorator changes runtime execution semantics. */
export function isDecoratorAnnotation(name: string): boolean {
  return DECORATOR_ANNOTATIONS.has(name);
}

export interface AdviceInfo {
  /** Advice method node id. */
  id: string;
  /** Enclosing aspect type. */
  typeId: string;
  name: string;
  adviceKind: string;
  pointcut: string;
}

export interface DynamicBuildResult {
  edges: GraphEdge[];
  adviceCount: number;
  dispatchCount: number;
  aspects: number;
}

interface MethodContext {
  method: MethodInfo;
  typeAnnotations: AnnotationInfo[];
}

/**
 * Build `ADVISES` and `DYNAMIC_DISPATCH` edges.
 *
 * `calls` should contain every CALLS edge in the project (used to seed virtual
 * dispatch). Both endpoints must already exist in `knownNodeIds`.
 */
export function buildDynamicEdges(
  parsedFiles: ParsedFile[],
  index: TypeIndex,
  knownNodeIds: Set<string>,
  calls: GraphEdge[]
): DynamicBuildResult {
  const typeAnnotations = new Map<string, AnnotationInfo[]>();
  for (const file of parsedFiles) {
    for (const type of file.types) typeAnnotations.set(type.id, type.annotations);
    if (file.packageName) {
      for (const type of file.types) typeAnnotations.set(type.id, type.annotations);
    }
  }

  const advice = collectAdvice(parsedFiles, typeAnnotations);
  const adviceEdges = buildAdviceEdges(advice, index, typeAnnotations, knownNodeIds);
  const dispatchEdges = buildDispatchEdges(index, knownNodeIds, calls);

  return {
    edges: [...adviceEdges, ...dispatchEdges],
    adviceCount: adviceEdges.length,
    dispatchCount: dispatchEdges.length,
    aspects: new Set(advice.map((a) => a.typeId)).size,
  };
}

/** Collect advice methods and resolve named pointcut references. */
export function collectAdvice(
  parsedFiles: ParsedFile[],
  typeAnnotations: Map<string, AnnotationInfo[]>
): AdviceInfo[] {
  const pointcutsByType = new Map<string, Map<string, string>>();
  const allMethods: MethodContext[] = [];

  for (const file of parsedFiles) {
    for (const method of file.methods) {
      allMethods.push({ method, typeAnnotations: typeAnnotations.get(method.typeId) ?? [] });
      if (method.adviceKind === "pointcut" && method.pointcut) {
        const byType = pointcutsByType.get(method.typeId) ?? new Map<string, string>();
        byType.set(method.name, method.pointcut);
        pointcutsByType.set(method.typeId, byType);
      }
    }
  }

  const advice: AdviceInfo[] = [];
  for (const { method } of allMethods) {
    if (!method.adviceKind || method.adviceKind === "pointcut" || !method.pointcut) continue;
    const expression = resolvePointcutReference(
      method.pointcut,
      method.typeId,
      pointcutsByType,
      new Set()
    );
    advice.push({
      id: method.id,
      typeId: method.typeId,
      name: method.name,
      adviceKind: method.adviceKind,
      pointcut: expression,
    });
  }
  return advice;
}

/** Expand `@Around("myPointcut()")` to the referenced expression. */
function resolvePointcutReference(
  expression: string,
  typeId: string,
  pointcutsByType: Map<string, Map<string, string>>,
  seen: Set<string>
): string {
  const trimmed = expression.trim();
  const ref = trimmed.match(/^([\w.$]+)\s*\(\s*\)$/);
  if (!ref || !ref[1]) return trimmed;
  // Do not treat pointcut keywords (execution(...) etc.) as references.
  if (POINTCUT_KEYWORDS.has(ref[1])) return trimmed;

  const raw = ref[1];
  const simple = raw.split(".").pop() ?? raw;
  const key = `${typeId}#${simple}`;
  if (seen.has(key)) return trimmed;
  seen.add(key);

  const local = pointcutsByType.get(typeId)?.get(simple);
  if (local) return resolvePointcutReference(local, typeId, pointcutsByType, seen);

  for (const [owner, byType] of pointcutsByType) {
    if (raw.includes(".") && !owner.endsWith(raw.slice(0, raw.lastIndexOf(".")))) continue;
    const found = byType.get(simple);
    if (found) return resolvePointcutReference(found, owner, pointcutsByType, seen);
  }
  return trimmed;
}

function buildAdviceEdges(
  advice: AdviceInfo[],
  index: TypeIndex,
  typeAnnotations: Map<string, AnnotationInfo[]>,
  knownNodeIds: Set<string>
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const entry of advice) {
    if (!knownNodeIds.has(entry.id)) continue;
    for (const [typeId, methods] of index.methodsByFqn) {
      const annotations = typeAnnotations.get(typeId) ?? [];
      for (const method of methods) {
        if (method.id === entry.id) continue;
        if (!knownNodeIds.has(method.id)) continue;
        const result = matchPointcut(entry.pointcut, method, annotations, method.annotations);
        if (!result.matched) continue;

        const key = `${entry.id}->${method.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        edges.push({
          source: entry.id,
          target: method.id,
          kind: "ADVISES",
          properties: {
            adviceKind: entry.adviceKind,
            pointcut: entry.pointcut,
            confidence: round(result.confidence),
            reason: result.reason,
          },
        });
      }
    }
  }
  return edges;
}

function buildDispatchEdges(
  index: TypeIndex,
  knownNodeIds: Set<string>,
  calls: GraphEdge[]
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    if (call.kind !== "CALLS" || call.properties.resolved !== true) continue;
    const target = call.target;
    if (!target.includes("#")) continue;
    const separator = target.lastIndexOf("#");
    const declaringType = target.slice(0, separator);
    const methodName = target.slice(separator + 1);
    if (!methodName || methodName === "<init>") continue;

    const declared = (index.methodsByFqn.get(declaringType) ?? []).filter(
      (m) => m.name === methodName
    );
    if (declared.length === 0) continue;
    // Java only dispatches virtually for instance methods that are not final.
    if (
      declared.some((m) =>
        m.modifiers.some((mod) => mod === "private" || mod === "static" || mod === "final")
      )
    ) {
      continue;
    }

    const targetMethod = declared.find((m) => m.id === target) ?? declared[0];
    const arity = targetMethod?.params.length;
    const subtypes = index.subtypesOf(declaringType);
    if (subtypes.length === 0) continue;

    for (const subtype of subtypes) {
      const candidates = (index.methodsByFqn.get(subtype) ?? []).filter(
        (m) => m.name === methodName
      );
      if (candidates.length === 0) continue;
      const impl =
        candidates.find((m) => arity === undefined || m.params.length === arity) ?? candidates[0];
      if (!impl || impl.id === target || !knownNodeIds.has(impl.id)) continue;

      const key = `${target}->${impl.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        source: target,
        target: impl.id,
        kind: "DYNAMIC_DISPATCH",
        properties: {
          resolved: true,
          confidence: 0.8,
          via: `virtual dispatch to ${subtype}`,
          reason: `possible override of ${target} in ${subtype}`,
        },
      });
    }
  }
  return edges;
}

// ---------------------------------------------------------------- pointcuts

const POINTCUT_KEYWORDS = new Set([
  "execution",
  "call",
  "within",
  "withincode",
  "target",
  "this",
  "args",
  "bean",
  "annotation",
]);

const MODIFIER_KEYWORDS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "default",
  "strictfp",
]);

export interface PointcutMatch {
  matched: boolean;
  confidence: number;
  reason: string;
}

/**
 * Match an AspectJ-style pointcut against a declared method.
 *
 * Supported primitives: `execution`/`call`, `within`, `@annotation`,
 * `@within`, `target`, `this`, `args`, plus `&&`, `||` and `!`. Unsupported
 * primitives (e.g. `bean`, `controlflow`) simply do not match, so advice is
 * never over-applied.
 */
export function matchPointcut(
  expression: string,
  method: MethodInfo,
  typeAnnotations: AnnotationInfo[],
  methodAnnotations: AnnotationInfo[]
): PointcutMatch {
  const expr = (expression ?? "").trim();
  if (!expr) {
    // An empty pointcut is treated as "matches everything" with low confidence.
    return { matched: true, confidence: 0.3, reason: "empty pointcut" };
  }

  const orGroups = splitTopLevel(expr, "||");
  const reasons: string[] = [];
  let best: PointcutMatch | null = null;

  for (const group of orGroups) {
    const terms = splitTopLevel(group, "&&");
    if (terms.length === 0) continue;
    let matched = true;
    let confidence = 1;
    const termReasons: string[] = [];

    for (const term of terms) {
      const result = evaluateTerm(term, method, typeAnnotations, methodAnnotations);
      if (!result.matched) {
        matched = false;
        break;
      }
      confidence = Math.min(confidence, result.confidence);
      termReasons.push(result.reason);
    }

    if (matched) {
      const candidate: PointcutMatch = {
        matched: true,
        confidence,
        reason: termReasons.join(" && "),
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
      reasons.push(candidate.reason);
    }
  }

  return best ?? { matched: false, confidence: 0, reason: "no pointcut branch matched" };
}

function evaluateTerm(
  term: string,
  method: MethodInfo,
  typeAnnotations: AnnotationInfo[],
  methodAnnotations: AnnotationInfo[]
): PointcutMatch {
  let raw = term.trim();
  let negate = false;
  while (raw.startsWith("!")) {
    negate = true;
    raw = raw.slice(1).trim();
  }
  if (!raw) return { matched: false, confidence: 0, reason: "empty pointcut term" };

  const result = evaluatePrimitive(raw, method, typeAnnotations, methodAnnotations);
  if (!negate) return result;
  return {
    matched: !result.matched,
    confidence: result.matched ? result.confidence : 0,
    reason: `!(${result.reason})`,
  };
}

function evaluatePrimitive(
  raw: string,
  method: MethodInfo,
  typeAnnotations: AnnotationInfo[],
  methodAnnotations: AnnotationInfo[]
): PointcutMatch {
  const parsed = raw.match(/^([\w@]+)\s*\(([\s\S]*)\)$/);
  if (!parsed) {
    return { matched: false, confidence: 0, reason: `unsupported pointcut "${raw}"` };
  }
  const primitive = parsed[1] ?? "";
  const body = (parsed[2] ?? "").trim();

  switch (primitive) {
    case "execution":
    case "call": {
      const matched = matchExecution(body, method);
      return {
        matched,
        confidence: primitive === "execution" ? 0.9 : 0.85,
        reason: `${primitive}(${body})${matched ? "" : " did not match"}`,
      };
    }
    case "within": {
      const matched = matchTypePattern(body, method.typeId);
      return {
        matched,
        confidence: 0.85,
        reason: `within(${body})${matched ? "" : " did not match"} ${method.typeId}`,
      };
    }
    case "@annotation": {
      const matched = matchAnnotationPattern(body, methodAnnotations);
      return {
        matched,
        confidence: 0.85,
        reason: `@annotation(${body})${matched ? "" : " did not match"}`,
      };
    }
    case "@within": {
      const matched = matchAnnotationPattern(body, typeAnnotations);
      return {
        matched,
        confidence: 0.8,
        reason: `@within(${body})${matched ? "" : " did not match"}`,
      };
    }
    case "target":
    case "this": {
      const matched = matchTypePattern(body, method.typeId);
      return {
        matched,
        confidence: 0.55,
        reason: `${primitive}(${body})${matched ? "" : " did not match"} (static approximation)`,
      };
    }
    case "args": {
      const matched = matchArity(body, method.params.length);
      return {
        matched,
        confidence: 0.6,
        reason: `args(${body})${matched ? "" : " did not match"} arity ${method.params.length}`,
      };
    }
    default:
      return {
        matched: false,
        confidence: 0,
        reason: `unsupported pointcut primitive "${primitive}"`,
      };
  }
}

/** Match an `execution(...)` signature against a method. */
export function matchExecution(signature: string, method: MethodInfo): boolean {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < open) return false;

  const paramsText = signature.slice(open + 1, close);
  const before = signature.slice(0, open).trim();
  const tokens = before.split(/\s+/).filter(Boolean);
  // Drop modifiers and leading annotations.
  const filtered = tokens.filter(
    (token) => !MODIFIER_KEYWORDS.has(token) && !token.startsWith("@")
  );
  const target = filtered[filtered.length - 1];
  if (!target) return false;

  const dot = target.lastIndexOf(".");
  const methodPattern = dot >= 0 ? target.slice(dot + 1) : target;
  const typePattern = dot >= 0 ? target.slice(0, dot) : "*";

  if (!matchNameGlob(methodPattern, method.name)) return false;
  if (!matchTypePattern(typePattern, method.typeId)) return false;
  return matchArity(paramsText, method.params.length);
}

/** Simple `*` glob over method names. */
function matchNameGlob(pattern: string, name: string): boolean {
  if (!pattern || pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Match an AspectJ type pattern.
 *  - `*` matches any type
 *  - `com.acme.*` matches one package level
 *  - `com.acme..*` matches any depth below `com.acme`
 *  - `..Foo` matches a type named Foo at any depth
 */
export function matchTypePattern(pattern: string, typeFqn: string): boolean {
  const cleaned = pattern.trim();
  if (!cleaned || cleaned === "*" || cleaned === "..") return true;
  const segments = cleaned.split(".");
  let regex = "^";
  let first = true;
  for (const segment of segments) {
    if (segment === "") {
      regex += "(?:\\.[^.]+)*";
      first = false;
      continue;
    }
    if (!first) regex += "\\.";
    regex += segment
      .split("*")
      .map((part) => escapeRegExp(part))
      .join("[^.]*");
    first = false;
  }
  regex += "$";
  return new RegExp(regex).test(typeFqn);
}

/** Whether any annotation matches a simple/globbed annotation pattern. */
function matchAnnotationPattern(pattern: string, annotations: AnnotationInfo[]): boolean {
  const cleaned = pattern.trim();
  if (!cleaned) return annotations.length > 0;
  const simple = cleaned.split(".").pop() ?? cleaned;
  return annotations.some(
    (annotation) =>
      matchNameGlob(simple, annotation.name) ||
      (annotation.fqn !== undefined && matchTypePattern(cleaned, annotation.fqn))
  );
}

function matchArity(paramsText: string, count: number): boolean {
  const trimmed = paramsText.trim();
  if (!trimmed) return count === 0;
  const parts = splitTopLevel(trimmed, ",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p === "..")) return true;
  return parts.length === count;
}

function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && input.startsWith(separator, i)) {
      out.push(input.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
