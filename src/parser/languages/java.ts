import type {
  CallSite,
  FieldInfo,
  LanguageConfig,
  MethodInfo,
  ParsedFile,
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
  walk,
  type TSNode,
} from "../treeSitter.js";

/**
 * Java extraction via the tree-sitter-java grammar.
 *
 * Produces structural entities (package, types, methods, constructors, fields,
 * imports) and raw call sites. The Java resolver consumes the call sites and
 * the per-method local-variable tables to resolve call targets.
 */

const GRAMMAR_PACKAGE = "tree-sitter-java";
const GRAMMAR_WASM = "tree-sitter-java.wasm";

export interface JavaParsedFile extends ParsedFile {
  /**
   * Simple name -> qualified name for types declared in this file and for
   * imported types. Used by the resolver for same-file name resolution.
   */
  typeByName: Map<string, string>;
}

export const javaConfig: LanguageConfig = {
  name: "java",
  extensions: ["java"],
  loadGrammar: () => loadGrammar(GRAMMAR_PACKAGE, GRAMMAR_WASM),
  parseFile,
};

function isTypeDecl(type: string): boolean {
  return (
    type === "class_declaration" ||
    type === "interface_declaration" ||
    type === "enum_declaration"
  );
}

function typeKind(node: TSNode): TypeKind {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  return "class";
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
  const localsByMethod = new Map<string, Map<string, string>>();

  // === Pass A: structural extraction with nesting stack for type FQNs. ===
  const nestingStack: string[] = [];

  function visitType(node: TSNode): void {
    const simple = typeName(node);
    const outer = nestingStack[nestingStack.length - 1];
    // `outer` is the enclosing type's full FQN (package included), so a nested
    // type extends it directly. Top-level types get the package prefix.
    const id = outer ? `${outer}.${simple}` : packageName ? `${packageName}.${simple}` : simple;

    types.push({
      id,
      kind: typeKind(node),
      name: simple,
      extendsTypes: extractExtends(node),
      implementsTypes: extractImplements(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    });
    nestingStack.push(id);

    const body = fieldChild(node, "body") ?? childOfType(node, "class_body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "method_declaration") {
          extractMethod(member, id);
        } else if (member.type === "constructor_declaration") {
          extractConstructor(member, id);
        } else if (member.type === "field_declaration") {
          extractFields(member, id);
        } else if (isTypeDecl(member.type)) {
          visitType(member);
        }
      }
    }

    nestingStack.pop();
  }

  function extractMethod(node: TSNode, typeId: string): void {
    const name = childOfType(node, "identifier")?.text ?? "";
    const id = `${typeId}#${name}`;
    methods.push({
      id,
      typeId,
      name,
      isConstructor: false,
      params: extractParams(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      returnType: extractReturnType(node),
      modifiers: extractModifiers(node),
    });
    const locals = collectLocals(node);
    if (locals) localsByMethod.set(id, locals);
  }

  function extractConstructor(node: TSNode, typeId: string): void {
    const id = `${typeId}#<init>`;
    methods.push({
      id,
      typeId,
      name: "<init>",
      isConstructor: true,
      params: extractParams(node),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
      returnType: "",
      modifiers: extractModifiers(node),
    });
    const locals = collectLocals(node);
    if (locals) localsByMethod.set(id, locals);
  }

  function extractFields(node: TSNode, typeId: string): void {
    const typeNode = typeNodeOf(node);
    const type = typeNode ? baseTypeName(typeNode.text) : "";
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
      });
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
      callSites.push({
        line: node.startPosition.row,
        receiver: info.receiver,
        name: info.name,
        argumentTexts: info.args,
        enclosingTypeId: enclosingId(typeRanges, node.startPosition.row) ?? "",
        enclosingMethodId: enclosingId(methodRanges, node.startPosition.row) ?? "",
        isConstructorCall: false,
        qualifiedReceiver: info.qualified,
      });
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
  return childOfType(pkg, "scoped_identifier")?.text ?? null;
}

function extractImports(root: TSNode): ParsedFile["imports"] {
  const result: ParsedFile["imports"] = [];
  for (const imp of childrenOfType(root, "import_declaration")) {
    const scoped = childOfType(imp, "scoped_identifier");
    if (!scoped) continue;
    const fqn = scoped.text;
    const isStatic = imp.namedChildren.some((c) => c.type === "static");
    result.push({ fqn, simpleName: simpleName(fqn), isStatic });
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
  for (const fp of childrenOfType(params, "formal_parameter")) {
    const typeNode = typeNodeOf(fp);
    const name = childOfType(fp, "identifier")?.text;
    const type = typeNode ? baseTypeName(typeNode.text) : "";
    if (name) out.push({ name, type });
  }
  return out;
}

function extractReturnType(node: TSNode): string {
  const ret = fieldChild(node, "type") ?? fieldChild(node, "result");
  if (ret) return baseTypeName(ret.text);
  if (childOfType(node, "void_type")) return "void";
  return "";
}

function extractModifiers(node: TSNode): string[] {
  const mods = fieldChild(node, "modifiers");
  if (!mods) return [];
  return mods.namedChildren.map((c) => c.text);
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
