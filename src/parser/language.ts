/**
 * Language-agnostic parsing contract.
 *
 * Each supported language implements a `LanguageConfig` that knows how to:
 *  - load its tree-sitter grammar (WASM)
 *  - extract structural entities (types, methods, fields, imports) and raw
 *    call sites from source text
 *
 * The crawler then converts a `ParsedFile` into graph nodes/edges and feeds the
 * raw call sites to the language-specific resolver.
 */

export type TypeKind = "class" | "interface" | "enum" | "annotation" | "module";

/** How a call site is nested: unconditional, or behind a guard. */
export type ControlFlowKind = "branch" | "loop" | "exception" | "predicate";

export interface ControlFlowInfo {
  kinds: ControlFlowKind[];
  /** Compact source text of the enclosing conditions (max 3). */
  guards: string[];
}

/**
 * An annotation (Java) or decorator (Python/TypeScript) applied to a symbol.
 * Kept deliberately simple: the name plus raw argument expressions, so the
 * resolver/crawler can interpret framework annotations without grammar-
 * specific models.
 */
export interface AnnotationInfo {
  /** Simple name as written in source, e.g. `Loggable`. */
  name: string;
  /** Qualified name when the source used one, e.g. `com.acme.Loggable`. */
  fqn?: string;
  /** Raw argument expressions, e.g. `["execution(* com.acme.Foo.bar(..))"]`. */
  arguments: string[];
  /** 0-based row of the annotation usage. */
  line: number;
}

export interface TypeInfo {
  /** Fully-qualified name, e.g. `com.acme.OrderService`. Nested types use `.`. */
  id: string;
  kind: TypeKind;
  name: string;
  /** Simple or qualified names from the `extends` clause. */
  extendsTypes: string[];
  /** Simple or qualified names from the `implements` clause. */
  implementsTypes: string[];
  /** 0-based row of the declaration start. */
  startLine: number;
  /** 0-based row of the declaration end. */
  endLine: number;
  /** Annotations/decorators applied to the type. */
  annotations: AnnotationInfo[];
  /** True when the type is an aspect (`@Aspect`). */
  isAspect?: boolean;
  /** Export visibility. Modules and members default to file-visible. */
  exported?: boolean;
}

/**
 * A call site whose target is only known at run time
 * (`Class.forName`, `getattr`, `require`, dynamic `import()`, ...).
 */
export interface ReflectiveRef {
  /** Framework/API that performs the lookup, e.g. `Class.forName`, `getattr`. */
  mechanism: string;
  /** What the lookup produces. */
  targetKind: "type" | "module" | "method";
  /** Raw target text as written (quotes stripped when it is a string literal). */
  target: string;
  /** Receiver expression for member lookups, e.g. `this.registry`. */
  receiver?: string;
  enclosingTypeId: string;
  enclosingMethodId: string;
  line: number;
}

/** A dependency the framework supplies at run time rather than the call site. */
export interface InjectionPoint {
  kind: "field" | "constructor-parameter" | "parameter" | "method";
  /** Id of the type (or module) that owns the injection point. */
  ownerId: string;
  /** Field or parameter name. */
  name: string;
  /** Raw declared type text (empty when only a token/decorator was given). */
  type: string;
  /** Framework that performs the injection, e.g. `spring`, `nestjs`. */
  framework: string;
  line: number;
  optional?: boolean;
}

/** Why a method is a root even though nothing in the source calls it. */
export type EntryPointKind = "http" | "messaging" | "scheduler" | "event" | "cli" | "test" | "route";

export interface EntryPointInfo {
  kind: EntryPointKind;
  /** Framework detail, e.g. `GET /orders/{id}` or `@Scheduled`. */
  detail?: string;
}

/** Express-style route registration resolved to a handler by name. */
export interface RouteRegistration {
  framework: string;
  httpMethod: string;
  path: string;
  handlerName: string;
  moduleId: string;
  enclosingTypeId: string;
  line: number;
}

export interface MethodInfo {
  /** Node id, e.g. `com.acme.OrderService#place` (or `#<init>` for constructors). */
  id: string;
  /** FQN of the enclosing type. */
  typeId: string;
  name: string;
  /** Whether this is a constructor. */
  isConstructor: boolean;
  /** Parameter names and raw type text. */
  params: { name: string; type: string }[];
  startLine: number;
  endLine: number;
  /** Raw return type text (empty for constructors). */
  returnType: string;
  /** Modifiers extracted from source (public, private, static, ...). */
  modifiers: string[];
  /** Annotations/decorators applied to the method. */
  annotations: AnnotationInfo[];
  /**
   * Aspect advice kind when this method is advice
   * (before | after | around | afterReturning | afterThrowing | pointcut).
   */
  adviceKind?: string;
  /** AspectJ pointcut expression carried by advice/pointcut methods. */
  pointcut?: string;
  /** Why this method is an entry point (framework-invoked root). */
  entryPoint?: EntryPointInfo;
}

export interface FieldInfo {
  /** Node id, e.g. `com.acme.OrderService.repo`. */
  id: string;
  typeId: string;
  name: string;
  /** Raw type text, e.g. `OrderRepository` or `List<String>`. */
  type: string;
  startLine: number;
  modifiers: string[];
  /** Annotations/decorators applied to the field. */
  annotations: AnnotationInfo[];
}

export interface ImportInfo {
  /** Full import text, e.g. `com.acme.OrderService`. */
  fqn: string;
  /** Short name used in source, e.g. `OrderService`. */
  simpleName: string;
  isStatic: boolean;
  /** Imported module/specifier for Python/TypeScript imports. */
  module?: string;
  /** Imported symbol when the import names one (`from x import y`). */
  importedName?: string;
  /** True for `import * as ns` / `import x` (the name refers to a module). */
  isNamespace?: boolean;
  /** Local alias, when different from the imported name. */
  alias?: string;
  /** Known-external module (non-relative TS specifier). */
  external?: boolean;
}

export interface CallSite {
  /** 0-based row of the call. */
  line: number;
  /**
   * Receiver expression text: `repo` for `repo.create(...)`, `this.repo` for
   * `this.repo.x()`, `com.acme.Foo` for a qualified static call, or null for
   * a bare `helper()` call.
   */
  receiver: string | null;
  /** Method or constructor name. */
  name: string;
  /** Raw source text of each argument expression. */
  argumentTexts: string[];
  /** FQN of the enclosing type. */
  enclosingTypeId: string;
  /** Id of the enclosing method (or constructor). */
  enclosingMethodId: string;
  /** True for `new Foo(...)` constructor calls. */
  isConstructorCall: boolean;
  /** True when the receiver looks like a qualified type (e.g. `com.acme.Foo.bar`). */
  qualifiedReceiver: boolean;
  /** Enclosing branches/loops/handlers and their guard text. */
  controlFlow?: ControlFlowInfo;
}

export interface ParsedFile {
  filePath: string;
  language: string;
  /** Declared package name, or null when absent. */
  packageName: string | null;
  imports: ImportInfo[];
  types: TypeInfo[];
  methods: MethodInfo[];
  fields: FieldInfo[];
  callSites: CallSite[];
  /**
   * Local variables per method id: `methodId -> (name -> base type text)`.
   * Used by the resolver for receiver-type inference.
   */
  localsByMethod: Map<string, Map<string, string>>;
  /** Module id for module-based languages (Python/TypeScript). */
  moduleId?: string;
  /**
   * Local name -> candidate type id (`module.Symbol`), from imports or local
   * declarations. Values may be unresolved guesses; the resolver validates.
   */
  scopeTypes?: Map<string, string>;
  /**
   * Local name -> candidate module id (`app.services.order`). Values may not
   * exist in the index; the resolver treats missing modules as external.
   */
  scopeModules?: Map<string, string>;
  /** Local name -> known-external package (non-relative imports). */
  externalModules?: Map<string, string>;
  /** Name exported by `export default` / `__all__`, when present. */
  defaultExportName?: string;
  /** Run-time-only targets (reflection, dynamic import, getattr). */
  reflectiveRefs?: ReflectiveRef[];
  /** Framework-injected dependencies declared by this file. */
  injections?: InjectionPoint[];
  /** Express/Fastify-style route registrations declared by this file. */
  routes?: RouteRegistration[];
  /** Entry point when the whole file is one (e.g. `__main__` script). */
  entryPoint?: EntryPointInfo;
  /** Total source lines, when the crawler already read the file. */
  lineCount?: number;
}

export interface ParseContext {
  /** Project root, used to derive stable module ids. */
  projectRoot?: string;
}

export interface LanguageConfig {
  /** Registry key, e.g. "java". */
  name: string;
  /** File extensions handled by this language (without the dot). */
  extensions: string[];
  /** Load (once) and return the compiled tree-sitter grammar. */
  loadGrammar(): Promise<unknown>;
  /** Extract structural entities + raw call sites from source text. */
  parseFile(source: string, filePath: string, context?: ParseContext): Promise<ParsedFile>;
}
