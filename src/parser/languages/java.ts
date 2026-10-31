import { controlFlowOf, type FlowSpec } from "../controlFlow.js";
import type {
  AnnotationInfo,
  CallSite,
  EntryPointInfo,
  FieldInfo,
  InjectionPoint,
  LanguageDescriptor,
  MethodInfo,
  ParsedFile,
  ReflectiveRef,
  TypeInfo,
  TypeKind,
} from "../language.js";
import {
  baseTypeName,
  childOfType,
  childrenOfType,
  createParser,
  fieldChild,
  loadGrammar,
  type TSNode,
  walk,
} from "../treeSitter.js";

/**
 * Java extraction via the tree-sitter-java grammar.
 *
 * Produces structural entities (package, types, methods, constructors, fields,
 * imports) and raw call sites. The Java resolver consumes the call sites and
 * the per-method local-variable tables to resolve call targets.
 */

const GRAMMAR_PACKAGE = "@vscode/tree-sitter-wasm";
const GRAMMAR_WASM = "wasm/tree-sitter-java.wasm";

export interface JavaParsedFile extends ParsedFile {
  /**
   * Simple name -> qualified name for types declared in this file and for
   * imported types. Used by the resolver for same-file name resolution.
   */
  typeByName: Map<string, string>;
}

export const javaConfig: LanguageDescriptor = {
  name: "java",
  extensions: ["java"],
  loadGrammar: () => loadGrammar(GRAMMAR_PACKAGE, GRAMMAR_WASM),
  parseFile,
  resolver: "java",
  frameworks: ["spring", "aspectj"],
  fixture: ["java", "sample"],
};

function isTypeDecl(type: string): boolean {
  return (
    type === "class_declaration" ||
    type === "interface_declaration" ||
    type === "enum_declaration" ||
    type === "annotation_type_declaration" ||
    type === "record_declaration"
  );
}

function typeKind(node: TSNode): TypeKind {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  if (node.type === "annotation_type_declaration") return "annotation";
  return "class";
}

/** Framework annotations that mark advice methods (Spring/AspectJ). */
const ADVICE_ANNOTATIONS: Record<string, string> = {
  Before: "before",
  After: "after",
  Around: "around",
  AfterReturning: "afterReturning",
  AfterThrowing: "afterThrowing",
  Pointcut: "pointcut",
};

/** Control-flow ancestors that make a call conditional in Java. */
const JAVA_FLOW: FlowSpec[] = [
  { type: "if_statement", kind: "branch", guardField: "condition" },
  { type: "switch_expression", kind: "branch", guardField: "condition" },
  { type: "switch_statement", kind: "branch", guardField: "condition" },
  { type: "conditional_expression", kind: "branch" },
  { type: "for_statement", kind: "loop", guardField: "condition" },
  { type: "enhanced_for_statement", kind: "loop" },
  { type: "while_statement", kind: "loop", guardField: "condition" },
  { type: "do_statement", kind: "loop", guardField: "condition" },
  { type: "catch_clause", kind: "exception" },
];

/** HTTP mapping annotations and the verb they imply. */
const HTTP_MAPPINGS: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: "ANY",
};

/** Framework-supplied injection annotations. */
const INJECTION_ANNOTATIONS: Record<string, string> = {
  Autowired: "spring",
  Inject: "jakarta",
  Resource: "jakarta",
  Value: "spring",
  Qualifier: "spring",
  ManagedProperty: "jakarta",
};

/** Run-time lookup methods and the kind of target they produce. */
const REFLECTIVE_METHODS: Record<
  string,
  { targetKind: ReflectiveRef["targetKind"]; mechanism: string }
> = {
  forName: { targetKind: "type", mechanism: "Class.forName" },
  loadClass: { targetKind: "type", mechanism: "ClassLoader.loadClass" },
  getMethod: { targetKind: "method", mechanism: "Class.getMethod" },
  getDeclaredMethod: { targetKind: "method", mechanism: "Class.getDeclaredMethod" },
  getConstructor: { targetKind: "method", mechanism: "Class.getConstructor" },
  getDeclaredConstructor: { targetKind: "method", mechanism: "Class.getDeclaredConstructor" },
  getField: { targetKind: "method", mechanism: "Class.getField" },
  getDeclaredField: { targetKind: "method", mechanism: "Class.getDeclaredField" },
};

/** Why a Java method is invoked by the framework rather than by source. */
function javaEntryPointOf(
  annotations: AnnotationInfo[],
  name: string,
  modifiers: string[]
): EntryPointInfo | undefined {
  for (const annotation of annotations) {
    const simple = annotation.name;
    const httpVerb = HTTP_MAPPINGS[simple];
    if (httpVerb) {
      const path = annotationValue(annotation) ?? "/";
      return { kind: "http", detail: `${httpVerb} ${path}` };
    }
    if (
      simple === "KafkaListener" ||
      simple === "RabbitListener" ||
      simple === "JmsListener" ||
      simple === "StreamListener" ||
      simple === "SqsListener"
    ) {
      const topic = annotationValue(annotation);
      return { kind: "messaging", detail: topic ? `${simple}(${topic})` : simple };
    }
    if (simple === "Scheduled") {
      const cron = annotation.arguments[0];
      return { kind: "scheduler", detail: cron ? `@Scheduled(${cron})` : "@Scheduled" };
    }
    if (simple === "EventListener" || simple === "TransactionalEventListener") {
      return { kind: "event", detail: simple };
    }
    if (simple === "Test" || simple === "ParameterizedTest" || simple === "RepeatedTest") {
      return { kind: "test", detail: simple };
    }
  }
  if (name === "main" && modifiers.includes("static")) {
    return { kind: "cli", detail: "main" };
  }
  return undefined;
}

/** Framework that injects the annotated symbol, if any. */
function injectionFrameworkOf(annotations: AnnotationInfo[]): string | null {
  for (const annotation of annotations) {
    const framework = INJECTION_ANNOTATIONS[annotation.name];
    if (framework) return framework;
  }
  return null;
}

/** Extract simple/qualified type names from a `superclass`/`super_interfaces` node. */
function superTypes(node: TSNode): string[] {
  const list = childOfType(node, "type_list");
  const types = list ? list.namedChildren : node.namedChildren;
  return types
    .map((t) => {
      // type_identifier | scoped_type_identifier | generic_type
      return childOfType(t, "type_identifier")?.text ?? t.text;
    })
    .filter((t) => t.length > 0);
}

function simpleName(text: string): string {
  const parts = text.split(".");
  return parts[parts.length - 1] ?? text;
}

/**
 * Find the type node in a declaration (field_declaration,
 * local_variable_declaration, formal_parameter, ...) by skipping the
 * `modifiers`/`variable_declarator` children that surround it.
 */
function typeNodeOf(decl: TSNode): TSNode | null {
  for (const child of decl.namedChildren) {
    if (child.type === "modifiers" || child.type === "variable_declarator") continue;
    return child;
  }
  return null;
}

export async function parseFile(source: string, filePath: string): Promise<JavaParsedFile> {
  const grammar = (await javaConfig.loadGrammar()) as import("web-tree-sitter").Language;
  const parser = createParser(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`failed to parse ${filePath}`);
  const root = tree.rootNode;

  const packageName = extractPackage(root);
  const imports = extractImports(root);

  const types: TypeInfo[] = [];
  const methods: MethodInfo[] = [];
  const fields: FieldInfo[] = [];
  const callSites: CallSite[] = [];
  const reflectiveRefs: ReflectiveRef[] = [];
  const injections: InjectionPoint[] = [];
  const localsByMethod = new Map<string, Map<string, string>>();
  /** Method ids emitted so far, so overloads stay distinct instead of collapsing. */
  const usedMethodIds = new Set<string>();

  /**
   * `Type#name` for the first declaration of a name and `Type#name(int,String)`
   * for each later overload. Single-declaration methods (the common case) keep
   * the bare id; overloads stay individually addressable in the graph.
   */
  function methodIdFor(
    typeId: string,
    name: string,
    params: { type: string }[],
    variadic = false
  ): string {
    const base = `${typeId}#${name}`;
    if (!usedMethodIds.has(base)) {
      usedMethodIds.add(base);
      return base;
    }
    const signature = params
      .map((param, index) =>
        variadic && index === params.length - 1 ? `${param.type}...` : param.type || "?"
      )
      .join(",");
    let candidate = `${base}(${signature})`;
    for (let nth = 2; usedMethodIds.has(candidate); nth++)
      candidate = `${base}(${signature})#${nth}`;
    usedMethodIds.add(candidate);
    return candidate;
  }

  // === Pass A: structural extraction with nesting stack for type FQNs. ===
  const nestingStack: string[] = [];

  function visitType(node: TSNode): void {
    const simple = typeName(node);
    const outer = nestingStack[nestingStack.length - 1];
    // `outer` is the enclosing type's full FQN (package included), so a nested
    // type extends it directly. Top-level types get the package prefix.
    const id = outer ? `${outer}.${simple}` : packageName ? `${packageName}.${simple}` : simple;

    const annotations = extractAnnotations(node);
    const isRecord = node.type === "record_declaration";
    types.push({
      id,
      kind: typeKind(node),
      name: simple,
      extendsTypes: extractExtends(node),
      implementsTypes: extractImplements(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      annotations,
      isAspect: annotations.some((a) => isNamed(a, "Aspect")),
      ...(isRecord ? { isRecord: true } : {}),
    });
    nestingStack.push(id);

    // Record components are fields plus an implicit accessor each.
    const components = isRecord ? extractRecordComponents(node, id) : [];

    const body = fieldChild(node, "body") ?? childOfType(node, "class_body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "method_declaration") {
          extractMethod(member, id);
        } else if (member.type === "constructor_declaration") {
          extractConstructor(member, id);
        } else if (member.type === "compact_constructor_declaration") {
          extractCompactConstructor(member, id, components);
        } else if (member.type === "field_declaration") {
          extractFields(member, id);
        } else if (isTypeDecl(member.type)) {
          visitType(member);
        }
      }
    }

    extractRecordAccessors(id, components, node.startPosition.row);

    nestingStack.pop();
  }

  /**
   * Record components declared in the header. Each one is a `private final`
   * field, and — unless the source overrides it — an accessor of the same name.
   */
  function extractRecordComponents(node: TSNode, typeId: string): { name: string; type: string }[] {
    const params = fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters");
    if (!params) return [];
    const components: { name: string; type: string }[] = [];
    for (const param of params.namedChildren) {
      // `int... values` is a legal last component and parses as spread_parameter.
      if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
      const name =
        param.type === "spread_parameter"
          ? firstIdentifier(param)?.text
          : childOfType(param, "identifier")?.text;
      if (!name) continue;
      const typeNode = typeNodeOf(param);
      const type = typeNode ? baseTypeName(typeNode.text) : "";
      components.push({ name, type });
      fields.push({
        id: `${typeId}.${name}`,
        typeId,
        name,
        type,
        startLine: node.startPosition.row,
        modifiers: ["private", "final"],
        annotations: [],
      });
    }
    return components;
  }

  function extractRecordAccessors(
    typeId: string,
    components: { name: string; type: string }[],
    line: number
  ): void {
    for (const component of components) {
      // An explicit accessor in the body wins.
      if (methods.some((m) => m.typeId === typeId && m.name === component.name)) continue;
      const id = methodIdFor(typeId, component.name, []);
      methods.push({
        id,
        typeId,
        name: component.name,
        isConstructor: false,
        params: [],
        startLine: line,
        endLine: line,
        returnType: component.type,
        modifiers: ["public"],
        annotations: [],
      });
    }
  }

  function extractMethod(node: TSNode, typeId: string): void {
    const name = childOfType(node, "identifier")?.text ?? "";
    const params = extractParams(node);
    const id = methodIdFor(typeId, name, params, hasVarargs(node));
    const annotations = extractAnnotations(node);
    const advice = adviceOf(annotations);
    const modifiers = extractModifiers(node);
    const entryPoint = javaEntryPointOf(annotations, name, modifiers);
    methods.push({
      id,
      typeId,
      name,
      isConstructor: false,
      params,
      variadic: hasVarargs(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      returnType: extractReturnType(node),
      modifiers,
      annotations,
      ...advice,
      ...(entryPoint ? { entryPoint } : {}),
    });
    collectParamInjections(node, id, annotations);
    const locals = collectLocals(node);
    if (locals) localsByMethod.set(id, locals);
  }

  /** Constructor parameter injections: Spring/Jakarta constructor injection. */
  function collectParamInjections(
    node: TSNode,
    typeId: string,
    memberAnnotations: AnnotationInfo[]
  ): void {
    const paramsNode = fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters");
    if (!paramsNode) return;
    const memberFramework = injectionFrameworkOf(memberAnnotations);
    for (const fp of childrenOfType(paramsNode, "formal_parameter")) {
      const framework = injectionFrameworkOf(extractAnnotations(fp));
      if (!framework) continue;
      const name = childOfType(fp, "identifier")?.text ?? "";
      if (!name) continue;
      const typeNode = typeNodeOf(fp);
      injections.push({
        kind: "constructor-parameter",
        ownerId: typeId,
        name,
        type: typeNode ? baseTypeName(typeNode.text) : "",
        framework: framework ?? memberFramework ?? "unknown",
        line: fp.startPosition.row,
      });
    }
  }

  function extractConstructor(node: TSNode, typeId: string): void {
    const params = extractParams(node);
    const id = methodIdFor(typeId, "<init>", params, hasVarargs(node));
    const annotations = extractAnnotations(node);
    methods.push({
      id,
      typeId,
      name: "<init>",
      isConstructor: true,
      params,
      variadic: hasVarargs(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      returnType: "",
      modifiers: extractModifiers(node),
      annotations,
    });
    collectParamInjections(node, id, annotations);
    const locals = collectLocals(node);
    if (locals) localsByMethod.set(id, locals);
  }

  /** `record R(...) { R { … } }` — the canonical constructor has no params in source. */
  function extractCompactConstructor(
    node: TSNode,
    typeId: string,
    components: { name: string; type: string }[]
  ): void {
    const id = methodIdFor(typeId, "<init>", components);
    methods.push({
      id,
      typeId,
      name: "<init>",
      isConstructor: true,
      params: components.map((component) => ({ ...component })),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      returnType: "",
      modifiers: extractModifiers(node),
      annotations: extractAnnotations(node),
    });
    const locals = collectLocals(node);
    if (locals) localsByMethod.set(id, locals);
  }

  function extractFields(node: TSNode, typeId: string): void {
    const typeNode = typeNodeOf(node);
    const type = typeNode ? baseTypeName(typeNode.text) : "";
    const annotations = extractAnnotations(node);
    const framework = injectionFrameworkOf(annotations);
    for (const declarator of childrenOfType(node, "variable_declarator")) {
      const name = childOfType(declarator, "identifier")?.text ?? "";
      if (!name) continue;
      fields.push({
        id: `${typeId}.${name}`,
        typeId,
        name,
        type,
        startLine: node.startPosition.row,
        modifiers: extractModifiers(node),
        annotations,
      });
      if (framework && !extractModifiers(node).includes("static")) {
        injections.push({
          kind: "field",
          ownerId: typeId,
          name,
          type,
          framework,
          line: node.startPosition.row,
        });
      }
    }
  }

  for (const child of root.namedChildren) {
    if (isTypeDecl(child.type)) visitType(child);
  }

  // === Pass B: flat walk for call sites. ===
  // Enclosing type/method are resolved by line range (innermost containing
  // the call site), so the walk does not need to maintain state.
  const typeRanges = types.map((t) => ({ id: t.id, start: t.startLine, end: t.endLine }));
  const methodRanges = methods.map((m) => ({ id: m.id, start: m.startLine, end: m.endLine }));

  walk(root, (node) => {
    if (node.type === "method_invocation") {
      const info = invocationInfo(node);
      const enclosingType = enclosingId(typeRanges, node.startPosition.row) ?? "";
      const enclosingMethod = enclosingId(methodRanges, node.startPosition.row) ?? "";
      callSites.push({
        line: node.startPosition.row,
        receiver: info.receiver,
        name: info.name,
        argumentTexts: info.args,
        enclosingTypeId: enclosingType,
        enclosingMethodId: enclosingMethod,
        isConstructorCall: false,
        qualifiedReceiver: info.qualified,
        controlFlow: controlFlowOf(node, JAVA_FLOW),
      });
      const reflection = reflectionOf(info, enclosingType, enclosingMethod, node.startPosition.row);
      if (reflection) reflectiveRefs.push(reflection);
    } else if (node.type === "object_creation_expression") {
      const typeNode = fieldChild(node, "type") ?? childOfType(node, "type_identifier");
      const argsNode = fieldChild(node, "arguments") ?? childOfType(node, "argument_list");
      callSites.push({
        line: node.startPosition.row,
        receiver: null,
        name: typeNode ? baseTypeName(typeNode.text) : "",
        argumentTexts: argsNode ? argsNode.namedChildren.map((c) => c.text) : [],
        enclosingTypeId: enclosingId(typeRanges, node.startPosition.row) ?? "",
        enclosingMethodId: enclosingId(methodRanges, node.startPosition.row) ?? "",
        isConstructorCall: true,
        qualifiedReceiver: false,
        controlFlow: controlFlowOf(node, JAVA_FLOW),
      });
    }
  });

  // Simple-name -> FQN map: file-declared types take precedence over imports.
  const typeByName = new Map<string, string>();
  for (const t of types) {
    if (!typeByName.has(t.name)) typeByName.set(t.name, t.id);
  }
  for (const imp of imports) {
    if (!imp.isStatic && !typeByName.has(imp.simpleName)) {
      typeByName.set(imp.simpleName, imp.fqn);
    }
  }

  return {
    filePath,
    language: "java",
    packageName,
    imports,
    types,
    methods,
    fields,
    callSites,
    localsByMethod,
    typeByName,
    scopeTypes: typeByName,
    reflectiveRefs,
    injections,
  };
}

/** Innermost symbol whose line range contains the given 0-based line. */
function enclosingId(
  ranges: { id: string; start: number; end: number }[],
  line: number
): string | null {
  let best: { id: string; start: number } | null = null;
  for (const r of ranges) {
    if (r.start <= line && r.end >= line) {
      if (!best || r.start > best.start) best = { id: r.id, start: r.start };
    }
  }
  return best?.id ?? null;
}

function extractPackage(root: TSNode): string | null {
  const pkg = childOfType(root, "package_declaration");
  if (!pkg) return null;
  return (
    childOfType(pkg, "scoped_identifier")?.text ?? childOfType(pkg, "identifier")?.text ?? null
  );
}

function extractImports(root: TSNode): ParsedFile["imports"] {
  const result: ParsedFile["imports"] = [];
  for (const imp of childrenOfType(root, "import_declaration")) {
    const scoped = childOfType(imp, "scoped_identifier") ?? childOfType(imp, "identifier");
    if (!scoped) continue;
    const isWildcard = imp.namedChildren.some((c) => c.type === "asterisk");
    const fqn = isWildcard ? `${scoped.text}.*` : scoped.text;
    const isStatic = imp.namedChildren.some((c) => c.type === "static");
    result.push({ fqn, simpleName: isWildcard ? "*" : simpleName(fqn), isStatic });
  }
  return result;
}

function extractExtends(node: TSNode): string[] {
  const sup = fieldChild(node, "superclass") ?? fieldChild(node, "extends_interfaces");
  return sup ? superTypes(sup) : [];
}

function extractImplements(node: TSNode): string[] {
  const ifaces = fieldChild(node, "interfaces");
  return ifaces ? superTypes(ifaces) : [];
}

function extractParams(node: TSNode): { name: string; type: string }[] {
  const params = fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters");
  if (!params) return [];
  const out: { name: string; type: string }[] = [];
  for (const fp of params.namedChildren) {
    // `String... names` parses as `spread_parameter`, not `formal_parameter`.
    // Collecting only the latter dropped the parameter, so every varargs
    // method looked like it took fewer arguments than it really does.
    if (fp.type !== "formal_parameter" && fp.type !== "spread_parameter") continue;
    const typeNode = typeNodeOf(fp);
    const name =
      fp.type === "spread_parameter"
        ? firstIdentifier(fp)?.text
        : childOfType(fp, "identifier")?.text;
    const type = typeNode ? baseTypeName(typeNode.text) : "";
    if (name) out.push({ name, type });
  }
  return out;
}

/** First `identifier` in a subtree; a varargs name sits inside a declarator. */
function firstIdentifier(node: TSNode): TSNode | null {
  if (node.type === "identifier") return node;
  for (const child of node.namedChildren) {
    const found = firstIdentifier(child);
    if (found) return found;
  }
  return null;
}

/** True when a declaration's parameter list ends in `Type... names`. */
function hasVarargs(node: TSNode): boolean {
  const params = fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters");
  return params ? params.namedChildren.some((p) => p.type === "spread_parameter") : false;
}

function extractReturnType(node: TSNode): string {
  const ret = fieldChild(node, "type") ?? fieldChild(node, "result");
  if (ret) return baseTypeName(ret.text);
  if (childOfType(node, "void_type")) return "void";
  return "";
}

function extractModifiers(node: TSNode): string[] {
  const mods = modifiersOf(node);
  if (!mods) return [];
  // Annotations live under `modifiers` too, but they are not modifiers:
  // they are modelled separately as decorator nodes and edges.
  return mods.children
    .filter((c) => c.type !== "annotation" && c.type !== "marker_annotation")
    .map((c) => c.text)
    .filter((text) => text.length > 0);
}

/**
 * tree-sitter-java exposes `modifiers` as a plain named child (no field), so
 * fall back to a type lookup when the grammar field is absent.
 */
function modifiersOf(node: TSNode): TSNode | null {
  return fieldChild(node, "modifiers") ?? childOfType(node, "modifiers");
}

/** Extract `@Annotation` / `@Annotation(args)` usages from a declaration. */
function extractAnnotations(node: TSNode): AnnotationInfo[] {
  const mods = modifiersOf(node);
  if (!mods) return [];
  const out: AnnotationInfo[] = [];
  for (const child of mods.namedChildren) {
    if (child.type !== "annotation" && child.type !== "marker_annotation") continue;
    const name = fieldChild(child, "name")?.text ?? "";
    if (!name) continue;
    const argsNode = fieldChild(child, "arguments");
    out.push({
      name: simpleName(name),
      fqn: name.includes(".") ? name : undefined,
      arguments: argsNode ? argsNode.namedChildren.map((c) => c.text) : [],
      line: child.startPosition.row,
    });
  }
  return out;
}

/** Whether an annotation matches a simple or qualified name. */
function isNamed(annotation: AnnotationInfo, simple: string): boolean {
  return (
    annotation.name === simple ||
    annotation.fqn === simple ||
    (annotation.fqn?.endsWith(`.${simple}`) ?? false)
  );
}

/** First string-literal argument of an annotation, unquoted. */
function annotationValue(annotation: AnnotationInfo): string | undefined {
  const raw =
    annotation.arguments.find((arg) => arg.trim().startsWith('"')) ?? annotation.arguments[0];
  return raw === undefined ? undefined : unquote(raw);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** Detect advice methods and capture their pointcut expression. */
function adviceOf(annotations: AnnotationInfo[]): { adviceKind?: string; pointcut?: string } {
  for (const annotation of annotations) {
    for (const [simple, kind] of Object.entries(ADVICE_ANNOTATIONS)) {
      if (isNamed(annotation, simple)) {
        return { adviceKind: kind, pointcut: annotationValue(annotation) };
      }
    }
  }
  return {};
}

/** Collect local variable types declared directly inside a method body. */
function collectLocals(methodNode: TSNode): Map<string, string> | null {
  const body = childOfType(methodNode, "block") ?? childOfType(methodNode, "constructor_body");
  if (!body) return null;
  const locals = new Map<string, string>();
  walk(body, (n) => {
    if (n.type === "local_variable_declaration") {
      const typeNode = typeNodeOf(n);
      const type = typeNode ? baseTypeName(typeNode.text) : "";
      if (!type) return;
      for (const decl of childrenOfType(n, "variable_declarator")) {
        const name = childOfType(decl, "identifier")?.text;
        if (name) locals.set(name, type);
      }
    }
  });
  return locals;
}

function invocationInfo(node: TSNode): {
  receiver: string | null;
  name: string;
  args: string[];
  qualified: boolean;
} {
  const nameNode = fieldChild(node, "name") ?? childOfType(node, "identifier");
  const objectNode = fieldChild(node, "object");
  const argsNode = fieldChild(node, "arguments") ?? childOfType(node, "argument_list");

  let receiver: string | null = null;
  let qualified = false;
  if (objectNode) {
    receiver = objectNode.text;
    // A receiver that is purely an identifier / scoped identifier usually means
    // a static call on a type, or a field access on a type reference.
    qualified =
      objectNode.type === "scoped_identifier" ||
      objectNode.type === "identifier" ||
      objectNode.type === "type_identifier" ||
      objectNode.type === "scoped_type_identifier";
  }

  return {
    receiver,
    name: nameNode?.text ?? "",
    args: argsNode ? argsNode.namedChildren.map((c) => c.text) : [],
    qualified,
  };
}

function typeName(node: TSNode): string {
  return fieldChild(node, "name")?.text ?? node.namedChild(0)?.text ?? "?";
}

/**
 * Detect run-time lookups (`Class.forName`, `getDeclaredMethod`, ...). These
 * have no static call target, so the resolver records them as REFLECTS edges.
 */
function reflectionOf(
  info: { receiver: string | null; name: string; args: string[] },
  enclosingTypeId: string,
  enclosingMethodId: string,
  line: number
): ReflectiveRef | null {
  const base = { enclosingTypeId, enclosingMethodId, line };
  if (info.name === "load" && info.receiver !== null && /ServiceLoader$/.test(info.receiver)) {
    const target = unquote(info.args[0] ?? "");
    return target ? { ...base, mechanism: "ServiceLoader.load", targetKind: "type", target } : null;
  }
  const spec = REFLECTIVE_METHODS[info.name];
  if (!spec || info.receiver === null) return null;
  if (
    spec.mechanism.startsWith("Class.getConstructor") ||
    spec.mechanism.startsWith("Class.getDeclaredConstructor")
  ) {
    return {
      ...base,
      mechanism: spec.mechanism,
      targetKind: "method",
      target: "<init>",
      receiver: info.receiver,
    };
  }
  const target = unquote(info.args[0] ?? "");
  if (!target) return null;
  return {
    ...base,
    mechanism: spec.mechanism,
    targetKind: spec.targetKind,
    target,
    receiver: info.receiver,
  };
}
