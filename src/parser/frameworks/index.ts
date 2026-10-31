import type { ImportInfo } from "../language.js";
import { aspectj } from "./aspectj.js";
import { celery } from "./celery.js";
import { dependencyInjector } from "./dependencyInjector.js";
import { events } from "./events.js";
import { express } from "./express.js";
import { fastapi } from "./fastapi.js";
import { fastify } from "./fastify.js";
import { flask } from "./flask.js";
import { jakarta } from "./jakarta.js";
import { jest } from "./jest.js";
import { junit } from "./junit.js";
import { nestjs } from "./nestjs.js";
import { nestjsParam } from "./nestjsParam.js";
import { pytest } from "./pytest.js";
import { quart } from "./quart.js";
import { spring } from "./spring.js";
import { tsDi } from "./tsDi.js";
import type { EntryPointSpec, FrameworkModule, FrameworkScope } from "./types.js";

export type { EntryPointSpec, FrameworkModule, FrameworkScope } from "./types.js";

/**
 * Registration order decides ties when no import evidence separates two claims,
 * so specific frameworks are listed before generic ones.
 */
const REGISTRY: FrameworkModule[] = [
  spring,
  jakarta,
  aspectj,
  junit,
  jest,
  nestjs,
  nestjsParam,
  fastapi,
  flask,
  quart,
  dependencyInjector,
  pytest,
  celery,
  events,
  express,
  fastify,
  tsDi,
];

const BY_NAME = new Map(REGISTRY.map((module) => [module.name, module]));

/** Every registered framework, in precedence order. */
export function listFrameworks(): FrameworkModule[] {
  return [...REGISTRY];
}

/** Registered framework names, in precedence order. */
export function frameworkNames(): string[] {
  return REGISTRY.map((module) => module.name);
}

export function frameworkNamed(name: string): FrameworkModule | undefined {
  return BY_NAME.get(name);
}

function evidenceMatches(importInfo: ImportInfo, module: FrameworkModule): boolean {
  const prefixes = module.evidence ?? [];
  if (prefixes.length === 0) return false;
  const candidates = [importInfo.fqn, importInfo.module, importInfo.importedName].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );
  return candidates.some((candidate) =>
    prefixes.some((prefix) => candidate === prefix || candidate.startsWith(prefix))
  );
}

/**
 * Build the conventions a file is judged against. Imports come first so a
 * project that evidences `dependency_injector` attributes `@inject` there,
 * while a Java file with no such import still falls back to the registry.
 */
export function frameworkScope(
  imports: ImportInfo[] = [],
  preferred: string[] = [],
  caseInsensitive = false
): FrameworkScope {
  const evidenced = REGISTRY.filter((module) =>
    imports.some((importInfo) => evidenceMatches(importInfo, module))
  );
  const preferredModules = preferred
    .map((name) => frameworkNamed(name))
    .filter((module): module is FrameworkModule => module !== undefined);
  return { evidenced, preferred: preferredModules, all: [...REGISTRY], caseInsensitive };
}

function ordered(scope: FrameworkScope): FrameworkModule[] {
  const seen = new Set<string>();
  const result: FrameworkModule[] = [];
  for (const module of [...scope.evidenced, ...scope.preferred, ...scope.all]) {
    if (seen.has(module.name)) continue;
    seen.add(module.name);
    result.push(module);
  }
  return result;
}

function lastSegment(name: string): string[] {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? [name] : [name, name.slice(dot + 1)];
}

function matchKey<T>(
  table: Record<string, T> | undefined,
  candidate: string,
  caseInsensitive: boolean
): T | undefined {
  if (!table) return undefined;
  const parts = lastSegment(candidate);
  for (const key of parts) {
    if (Object.hasOwn(table, key)) return table[key];
  }
  if (!caseInsensitive) return undefined;
  for (const [key, value] of Object.entries(table)) {
    const lower = key.toLowerCase();
    if (parts.some((part) => part.toLowerCase() === lower)) return value;
  }
  return undefined;
}

function matchQualifiedPrefix<T>(
  table: Record<string, T> | undefined,
  qualified: string
): T | undefined {
  if (!table) return undefined;
  const lower = qualified.toLowerCase();
  for (const [prefix, value] of Object.entries(table)) {
    if (lower.startsWith(prefix)) return value;
  }
  return undefined;
}

export interface EntryPointMatch {
  module: FrameworkModule;
  spec: EntryPointSpec;
}

/**
 * What an annotation means, if anything. `accept` lets a language keep its own
 * extra condition (Python only treats a verb decorator as HTTP when a receiver
 * or the `route` name is present).
 */
export function entryPointIn(
  scope: FrameworkScope,
  name: string,
  qualified?: string,
  accept?: (spec: EntryPointSpec) => boolean
): EntryPointMatch | undefined {
  for (const module of ordered(scope)) {
    const spec =
      matchKey(module.entryPoints, name, scope.caseInsensitive) ??
      (qualified ? matchQualifiedPrefix(module.qualifiedPrefixes, qualified) : undefined);
    if (!spec) continue;
    if (accept && !accept(spec)) continue;
    return { module, spec };
  }
  return undefined;
}

/** Framework label an annotation attributes an injection to. */
export function injectionIn(scope: FrameworkScope, name: string): string | undefined {
  for (const module of ordered(scope)) {
    const label = matchKey(module.injections, name, scope.caseInsensitive);
    if (label === undefined) continue;
    return label === true ? module.name : label;
  }
  return undefined;
}

/** Whether an annotation marks a class as container-managed. */
export function injectableIn(scope: FrameworkScope, name: string): boolean {
  return ordered(scope).some((module) =>
    (module.injectables ?? []).some((marker) =>
      scope.caseInsensitive ? marker.toLowerCase() === name.toLowerCase() : marker === name
    )
  );
}

/** Whether an annotation marks an aspect class. */
export function aspectIn(scope: FrameworkScope, name: string): boolean {
  return ordered(scope).some((module) =>
    (module.aspects ?? []).some((marker) =>
      scope.caseInsensitive ? marker.toLowerCase() === name.toLowerCase() : marker === name
    )
  );
}

export interface AdviceMatch {
  module: FrameworkModule;
  kind: string;
}

/** Advice kind an annotation implies (`before`, `around`, ...). */
export function adviceIn(scope: FrameworkScope, name: string): AdviceMatch | undefined {
  for (const module of ordered(scope)) {
    const kind = matchKey(module.advice, name, scope.caseInsensitive);
    if (kind) return { module, kind };
  }
  return undefined;
}

/** Injection label implied by a raw marker in a parameter list, e.g. `Depends(`. */
export function paramMarkerIn(scope: FrameworkScope, text: string): string | undefined {
  const compact = text.replace(/\s+/g, "");
  for (const module of ordered(scope)) {
    for (const [marker, label] of Object.entries(module.paramMarkers ?? {})) {
      if (compact.includes(marker.replace(/\s+/g, ""))) return label;
    }
  }
  return undefined;
}
