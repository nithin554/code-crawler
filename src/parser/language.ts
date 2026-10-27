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

export type TypeKind = "class" | "interface" | "enum" | "annotation";

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
}

export interface LanguageConfig {
  /** Registry key, e.g. "java". */
  name: string;
  /** File extensions handled by this language (without the dot). */
  extensions: string[];
  /** Load (once) and return the compiled tree-sitter grammar. */
  loadGrammar(): Promise<unknown>;
  /** Extract structural entities + raw call sites from source text. */
  parseFile(source: string, filePath: string): Promise<ParsedFile>;
}
