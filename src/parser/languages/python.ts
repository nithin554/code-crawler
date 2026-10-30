import { controlFlowOf, type FlowSpec, insideAny } from "../controlFlow.js";
import type {
  AnnotationInfo,
  CallSite,
  EntryPointInfo,
  FieldInfo,
  ImportInfo,
  InjectionPoint,
  LanguageConfig,
  MethodInfo,
  ParsedFile,
  ReflectiveRef,
  RouteRegistration,
  TypeInfo,
} from "../language.js";
import { moduleNodeId, pythonModuleId, resolvePythonRelative } from "../moduleId.js";
import {
  childOfType,
  childrenOfType,
  createParser,
  fieldChild,
  loadGrammar,
  sameNode,
  type TSNode,
  walk,
} from "../treeSitter.js";

/**
 * Python parser.
 *
 * Python has no packages, so a module (one file) is the namespace: its module
 * id is derived from the project-relative path. Module-level functions are
 * methods of the module node, which lets the resolver treat `module.fn()` and
 * `fn()` uniformly through the same `TypeIndex.findMethods` machinery Java uses
 * for static classes.
 *
 * Modelled beyond plain declarations:
 *  - decorators as annotations (framework entry points, DI, AOP-ish advice)
 *  - `self.x = Foo()` fields plus annotated class/module attributes
 *  - run-time lookups (`getattr`, `__import__`, `importlib.import_module`)
 *  - framework-injected parameters (`Depends(...)`, `Annotated[..., Depends]`)
 *  - control-flow context of every call site
 */

const PY_FLOWS: FlowSpec[] = [
  { type: "if_statement", kind: "branch", guardField: "condition" },
  { type: "elif_clause", kind: "branch", guardField: "condition" },
  { type: "else_clause", kind: "branch", guard: "else" },
  { type: "conditional_expression", kind: "branch", guardField: "condition" },
  { type: "for_statement", kind: "loop", guardField: "right" },
  { type: "async_for_statement", kind: "loop", guardField: "right" },
  { type: "while_statement", kind: "loop", guardField: "condition" },
  { type: "try_statement", kind: "exception", guard: "try" },
  { type: "except_clause", kind: "exception", guardField: "value" },
  { type: "finally_clause", kind: "exception", guard: "finally" },
  { type: "match_statement", kind: "branch", guardField: "subject" },
  { type: "case_clause", kind: "branch", guard: "case" },
  { type: "assert_statement", kind: "predicate", guardField: "condition" },
  { type: "boolean_operator", kind: "predicate" },
];

/** Calls below these nodes are declarations, not executable call sites. */
const SKIP_CALL_ANCESTORS = new Set([
  "decorator",
  "import_statement",
  "import_from_statement",
  "future_import_statement",
]);

const HTTP_VERBS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
  "route",
  "api_route",
  "websocket",
  "websocket_route",
]);

const ROUTE_RECEIVERS = new Set([
  "app",
  "api",
  "router",
  "bp",
  "blueprint",
  "server",
  "application",
  "fastify",
]);

const INJECTION_DECORATORS = new Set(["inject", "injectable", "autowired", "provide"]);

const BUILTIN_TYPES = new Set([
  "str",
  "int",
  "float",
  "bool",
  "bytes",
  "list",
  "dict",
  "set",
  "tuple",
  "object",
  "Exception",
  "BaseException",
  "ValueError",
  "TypeError",
  "KeyError",
  "RuntimeError",
  "OSError",
]);

interface MethodRange {
  startLine: number;
  endLine: number;
  id: string;
  typeId: string;
}

interface TypeRange {
  startLine: number;
  endLine: number;
  id: string;
}

export const pythonConfig: LanguageConfig = {
  name: "python",
  extensions: ["py", "pyi"],
  loadGrammar() {
    return loadGrammar("@vscode/tree-sitter-wasm", "wasm/tree-sitter-python.wasm");
  },
  async parseFile(source, filePath, context): Promise<ParsedFile> {
    const parser = createParser(
      (await pythonConfig.loadGrammar()) as import("web-tree-sitter").Language
    );
    const tree = parser.parse(source);
    parser.delete();
    if (!tree) throw new Error(`failed to parse ${filePath}`);
    const root = tree.rootNode;

    const moduleId = pythonModuleId(filePath, context?.projectRoot);
    const isPackageFile = /(^|[\\/])__init__\.[^\\/]+$/.test(filePath);
    const moduleTypeId = moduleNodeId(moduleId);

    const types: TypeInfo[] = [
      {
        id: moduleTypeId,
        kind: "module",
        name: moduleId.split(".").pop() ?? moduleId,
        extendsTypes: [],
        implementsTypes: [],
        startLine: 0,
        endLine: root.endPosition.row,
        annotations: [],
        exported: true,
      },
    ];
    const methods: MethodInfo[] = [];
    const fields: FieldInfo[] = [];
    const imports: ImportInfo[] = [];
    const callSites: CallSite[] = [];
    const localsByMethod = new Map<string, Map<string, string>>();
    const scopeTypes = new Map<string, string>();
    const scopeModules = new Map<string, string>();
    const reflectiveRefs: ReflectiveRef[] = [];
    const injections: InjectionPoint[] = [];
    const routes: RouteRegistration[] = [];

    const methodRanges: MethodRange[] = [];
    const typeRanges: TypeRange[] = [
      { startLine: 0, endLine: root.endPosition.row, id: moduleTypeId },
    ];
    const fieldIds = new Set<string>();

    const typeIdOf = (name: string, parentId: string | null): string =>
      parentId ? `${parentId}.${name}` : `${moduleId}.${name}`;

    const methodIdOf = (typeId: string, name: string, isCtor: boolean): string =>
      `${typeId}#${isCtor ? "<init>" : name}`;

    // ---------------------------------------------------------------- helpers

    function calleeName(node: TSNode | null): { name: string; fqn?: string } | null {
      if (!node) return null;
      if (node.type === "identifier") return { name: node.text };
      if (node.type === "attribute") {
        const attribute = fieldChild(node, "attribute");
        if (!attribute) return null;
        return { name: attribute.text, fqn: node.text };
      }
      if (node.type === "call") return calleeName(fieldChild(node, "function"));
      return null;
    }

    function annotationOf(decorator: TSNode): AnnotationInfo | null {
      const expression = decorator.namedChildren[0] ?? null;
      if (!expression) return null;
      if (expression.type === "call") {
        const named = calleeName(fieldChild(expression, "function"));
        if (!named) return null;
        const argsNode = fieldChild(expression, "arguments");
        const args = argsNode
          ? argsNode.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text)
          : [];
        return {
          name: named.name,
          fqn: named.fqn,
          arguments: args,
          line: decorator.startPosition.row,
        };
      }
      const named = calleeName(expression);
      if (!named) return null;
      return { name: named.name, fqn: named.fqn, arguments: [], line: decorator.startPosition.row };
    }

    function annotationsOf(decorators: TSNode[]): AnnotationInfo[] {
      return decorators.map((d) => annotationOf(d)).filter((a): a is AnnotationInfo => a !== null);
    }

    function unquote(raw: string): string {
      const match = raw.match(/^\s*(?:[rbfu]{0,2})?["']([\s\S]*?)["']\s*$/);
      return match ? (match[1] ?? "") : raw.trim();
    }

    function stringArgument(annotation: AnnotationInfo): string {
      for (const arg of annotation.arguments) {
        const value = unquote(arg);
        if (value !== arg.trim()) return value;
      }
      return "";
    }

    function entryPointOf(annotations: AnnotationInfo[], name: string): EntryPointInfo | undefined {
      for (const annotation of annotations) {
        const simple = annotation.name;
        const lower = simple.toLowerCase();
        const qualified = (annotation.fqn ?? simple).toLowerCase();
        const hasReceiver = qualified.includes(".");

        if (HTTP_VERBS.has(lower) && (hasReceiver || lower.endsWith("route"))) {
          const path = stringArgument(annotation);
          const method =
            lower === "route" || lower === "api_route" || lower === "websocket_route"
              ? ""
              : lower.toUpperCase();
          return { kind: "http", detail: `${method} ${path}`.trim() || qualified };
        }
        if (["task", "shared_task", "periodic_task", "celery_task"].includes(lower)) {
          return { kind: "messaging", detail: qualified };
        }
        if (["scheduled", "cron", "interval", "periodic_task"].includes(lower)) {
          return { kind: "scheduler", detail: qualified };
        }
        if (
          lower === "fixture" ||
          qualified.endsWith(".fixture") ||
          lower === "parametrize" ||
          lower.startsWith("mark.")
        ) {
          return { kind: "test", detail: qualified };
        }
        if (
          ["on_event", "listener", "receiver", "on_message", "subscribe", "handler"].includes(lower)
        ) {
          return { kind: "event", detail: qualified };
        }
      }
      if (name === "main" || name === "cli") return { kind: "cli", detail: name };
      if (/^test_/.test(name) || /_test$/.test(name)) return { kind: "test", detail: name };
      return undefined;
    }

    /**
     * FastAPI/Flask decorators register routes on the decorated function, so
     * the handler is only known once the function is visited. `app.route(...)`
     * without a verb also registers a route, hence the `ANY` fallback.
     */
    function decoratorRoutesOf(
      annotations: AnnotationInfo[],
      handlerName: string,
      ownerTypeId: string
    ): RouteRegistration[] {
      const found: RouteRegistration[] = [];
      for (const annotation of annotations) {
        const lower = annotation.name.toLowerCase();
        if (!HTTP_VERBS.has(lower)) continue;
        const qualified = annotation.fqn ?? annotation.name;
        const receiver = qualified.includes(".") ? qualified.slice(0, qualified.indexOf(".")) : "";
        if (!annotation.arguments.length && !receiver && !lower.endsWith("route")) continue;
        const verb =
          lower === "route" || lower === "api_route" || lower === "websocket_route"
            ? "ANY"
            : lower.toUpperCase();
        found.push({
          framework: receiver || "flask",
          httpMethod: verb,
          path: stringArgument(annotation),
          handlerName,
          moduleId,
          enclosingTypeId: ownerTypeId,
          line: annotation.line,
        });
      }
      return found;
    }

    function inferExpressionType(node: TSNode | null): string {
      if (!node) return "";
      switch (node.type) {
        case "call": {
          const named = calleeName(fieldChild(node, "function"));
          return named ? named.name : "";
        }
        case "string": {
          const prefix = node.children.find((c) => c.type === "string_start")?.text ?? "";
          if (prefix.includes("f")) return "str";
          if (prefix.includes("b")) return "bytes";
          return "str";
        }
        case "integer":
          return "int";
        case "float":
          return "float";
        case "true":
        case "false":
          return "bool";
        case "list":
        case "list_comprehension":
          return "list";
        case "dictionary":
        case "dictionary_comprehension":
          return "dict";
        case "set":
        case "set_comprehension":
          return "set";
        case "tuple":
          return "tuple";
        default:
          return "";
      }
    }

    function addField(
      typeId: string,
      name: string,
      type: string,
      line: number,
      annotations: AnnotationInfo[] = []
    ): void {
      const id = `${typeId}$${name}`;
      if (fieldIds.has(id)) return;
      fieldIds.add(id);
      fields.push({ id, typeId, name, type, startLine: line, modifiers: [], annotations });
    }

    /** Type text from a Python `type` node, ignoring surrounding noise. */
    function typeText(node: TSNode | null): string {
      if (!node) return "";
      return node.text.trim();
    }

    function parseParams(paramsNode: TSNode | null): { name: string; type: string }[] {
      if (!paramsNode) return [];
      const out: { name: string; type: string }[] = [];
      for (const param of paramsNode.namedChildren) {
        switch (param.type) {
          case "identifier":
            out.push({ name: param.text, type: "" });
            break;
          case "typed_parameter": {
            const nameNode = param.namedChildren.find((c) => c.type === "identifier");
            if (nameNode)
              out.push({ name: nameNode.text, type: typeText(fieldChild(param, "type")) });
            break;
          }
          case "default_parameter": {
            const nameNode = fieldChild(param, "name") ?? param.namedChildren[0];
            if (nameNode) out.push({ name: nameNode.text, type: "" });
            break;
          }
          case "typed_default_parameter": {
            const nameNode =
              fieldChild(param, "name") ?? param.namedChildren.find((c) => c.type === "identifier");
            if (nameNode)
              out.push({ name: nameNode.text, type: typeText(fieldChild(param, "type")) });
            break;
          }
          case "list_splat_pattern":
            out.push({ name: `*${param.text}`, type: "" });
            break;
          case "dictionary_splat_pattern":
            out.push({ name: `**${param.text}`, type: "" });
            break;
          case "keyword_separator":
          case "positional_separator":
            break;
          default:
            out.push({ name: param.text.replace(/\s+/g, " "), type: "" });
            break;
        }
      }
      return out;
    }

    function paramName(param: TSNode): { name: string; type: string } | null {
      switch (param.type) {
        case "identifier":
          return { name: param.text, type: "" };
        case "typed_parameter": {
          const nameNode = param.namedChildren.find((c) => c.type === "identifier");
          return nameNode
            ? { name: nameNode.text, type: typeText(fieldChild(param, "type")) }
            : null;
        }
        case "default_parameter": {
          const nameNode = fieldChild(param, "name") ?? param.namedChildren[0];
          return nameNode ? { name: nameNode.text, type: "" } : null;
        }
        case "typed_default_parameter": {
          const nameNode =
            fieldChild(param, "name") ?? param.namedChildren.find((c) => c.type === "identifier");
          return nameNode
            ? { name: nameNode.text, type: typeText(fieldChild(param, "type")) }
            : null;
        }
        default:
          return null;
      }
    }

    /** First type argument of `Wrapper[X, ...]`, or the text itself. */
    function firstTypeArgument(text: string, wrapper?: string): string {
      const match = text.match(/^([A-Za-z_][\w.]*)\[([\s\S]*)\]$/);
      if (!match) return text;
      const base = match[1] ?? "";
      if (wrapper && base.split(".").pop() !== wrapper) return text;
      const inner = match[2] ?? "";
      let depth = 0;
      for (let i = 0; i < inner.length; i++) {
        const char = inner.charAt(i);
        if (char === "[" || char === "(") depth++;
        else if (char === "]" || char === ")") depth--;
        else if (char === "," && depth === 0) return inner.slice(0, i).trim();
      }
      return inner.trim();
    }

    // ---------------------------------------------------------- declarations

    function superclassNames(argumentList: TSNode): string[] {
      const out: string[] = [];
      for (const arg of argumentList.namedChildren) {
        if (arg.type === "keyword_argument") continue;
        if (arg.type === "subscript") {
          const value = fieldChild(arg, "value") ?? arg.namedChildren[0];
          if (value) out.push(value.text);
          continue;
        }
        out.push(arg.text);
      }
      return out;
    }

    function visitClass(
      node: TSNode,
      decorators: AnnotationInfo[],
      parentTypeId: string | null
    ): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const id = typeIdOf(name, parentTypeId);
      const superclasses = fieldChild(node, "superclasses");
      const annotations = decorators;
      types.push({
        id,
        kind: "class",
        name,
        extendsTypes: superclasses ? superclassNames(superclasses) : [],
        implementsTypes: [],
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        annotations,
        isAspect: annotations.some((a) => a.name === "Aspect"),
        exported: true,
      });
      typeRanges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, id });
      scopeTypes.set(name, id);

      const injectable = annotations.some((a) => INJECTION_DECORATORS.has(a.name.toLowerCase()));
      const body = fieldChild(node, "body") ?? childOfType(node, "block");
      if (!body) return;

      for (const entry of definitionsIn(body)) {
        const childAnnotations = annotationsOf(entry.decorators);
        if (entry.definition.type === "class_definition") {
          visitClass(entry.definition, childAnnotations, id);
        } else if (entry.definition.type === "function_definition") {
          visitFunction(entry.definition, childAnnotations, id, injectable);
        } else if (entry.definition.type === "expression_statement") {
          collectAttributeFields(entry.definition, id);
        }
      }
    }

    function definitionsIn(block: TSNode): { definition: TSNode; decorators: TSNode[] }[] {
      const out: { definition: TSNode; decorators: TSNode[] }[] = [];
      for (const child of block.namedChildren) {
        if (child.type === "decorated_definition") {
          const definition = fieldChild(child, "definition");
          if (definition) out.push({ definition, decorators: childrenOfType(child, "decorator") });
        } else {
          out.push({ definition: child, decorators: [] });
        }
      }
      return out;
    }

    /** Class/module level `name: Type = ...` attributes. */
    function collectAttributeFields(statement: TSNode, ownerId: string): void {
      for (const assignment of statement.namedChildren) {
        if (assignment.type !== "assignment") continue;
        const left = fieldChild(assignment, "left") ?? assignment.namedChildren[0];
        if (left?.type !== "identifier") continue;
        const typeNode = fieldChild(assignment, "type");
        const right = fieldChild(assignment, "right");
        const type = typeNode ? typeText(typeNode) : inferExpressionType(right);
        addField(ownerId, left.text, type, assignment.startPosition.row);
        if (ownerId === moduleTypeId && type && type !== left.text) scopeTypes.set(left.text, type);
      }
    }

    function visitFunction(
      node: TSNode,
      annotations: AnnotationInfo[],
      ownerTypeId: string | null,
      ownerInjectable: boolean
    ): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "identifier");
      if (!nameNode) return;
      const rawName = nameNode.text;
      const owner = ownerTypeId ?? moduleTypeId;
      const isCtor = rawName === "__init__";
      const id = methodIdOf(owner, rawName, isCtor);
      const paramsNode = fieldChild(node, "parameters");
      const params = parseParams(paramsNode);
      const returnType = typeText(fieldChild(node, "return_type"));
      const modifiers: string[] = [];
      if (/^\s*async\b/.test(node.text)) modifiers.push("async");
      for (const annotation of annotations) {
        const lower = annotation.name.toLowerCase();
        if (
          lower === "staticmethod" ||
          lower === "classmethod" ||
          lower === "property" ||
          lower === "abstractmethod"
        ) {
          modifiers.push(lower);
        }
      }

      methods.push({
        id,
        typeId: owner,
        name: isCtor ? "<init>" : rawName,
        isConstructor: isCtor,
        params,
        variadic: params.some((p) => p.name.startsWith("*")),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        returnType,
        modifiers,
        annotations,
        entryPoint: entryPointOf(annotations, rawName),
      });
      methodRanges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        id,
        typeId: owner,
      });

      const isHandler = annotations.some((a) => HTTP_VERBS.has(a.name.toLowerCase()));
      if (isHandler) routes.push(...decoratorRoutesOf(annotations, rawName, owner));

      const locals = new Map<string, string>();
      for (const param of params) {
        if (param.type) locals.set(param.name.replace(/^\*+/, ""), param.type);
      }

      // Parameters supplied by the framework rather than by the caller.
      if (paramsNode) {
        const methodInjects = annotations.some((a) =>
          INJECTION_DECORATORS.has(a.name.toLowerCase())
        );
        for (const param of paramsNode.namedChildren) {
          const named = paramName(param);
          if (!named) continue;
          const raw = param.text;
          const depends = /Depends\s*\(/.test(raw);
          const injectDecorator = /@?Inject\s*\(/.test(raw);
          let declared = named.type;
          if (depends && declared) declared = firstTypeArgument(declared, "Annotated");
          if (depends || injectDecorator) {
            injections.push({
              kind: ownerTypeId ? (isCtor ? "constructor-parameter" : "parameter") : "parameter",
              ownerId: owner,
              name: named.name,
              type: declared || (depends ? "Depends" : "Inject"),
              framework: depends ? "fastapi" : "dependency-injector",
              line: param.startPosition.row,
              optional: /Optional\s*\[/.test(declared) || /=\s*None/.test(raw),
            });
          } else if (methodInjects && declared) {
            injections.push({
              kind: ownerTypeId ? (isCtor ? "constructor-parameter" : "parameter") : "parameter",
              ownerId: owner,
              name: named.name,
              type: declared,
              framework: "dependency-injector",
              line: param.startPosition.row,
            });
          } else if (ownerInjectable && isCtor && declared) {
            injections.push({
              kind: "constructor-parameter",
              ownerId: owner,
              name: named.name,
              type: declared,
              framework: "dependency-injector",
              line: param.startPosition.row,
            });
          }
        }
      }

      const body = fieldChild(node, "body") ?? childOfType(node, "block");
      if (body) collectLocalsAndFields(body, locals, owner, ownerTypeId, params);
      localsByMethod.set(id, locals);
    }

    /** Container type text -> the type yielded when iterating it. */
    function elementTypeOf(containerType: string): string {
      const text = (containerType ?? "").trim();
      const match = /^([A-Za-z_][\w.]*)\s*[[(](.+)[\])]$/.exec(text);
      if (!match) return "";
      const base = (match[1] ?? "").split(".").pop() ?? "";
      const first = (match[2] ?? "").split(",")[0]?.trim() ?? "";
      const yieldsFirstArg = new Set([
        "list",
        "List",
        "set",
        "Set",
        "frozenset",
        "FrozenSet",
        "Sequence",
        "Iterable",
        "Iterator",
        "Collection",
        "Generator",
        "deque",
        "Deque",
        "tuple",
        "Tuple",
        "dict",
        "Dict",
        "Mapping",
        "defaultdict",
      ]);
      return yieldsFirstArg.has(base) ? first : "";
    }

    /** Type text of the value an expression iterates over. */
    function iterableTypeOf(
      node: TSNode,
      locals: Map<string, string>,
      ownerTypeId: string | null
    ): string {
      if (node.type === "identifier") return locals.get(node.text) ?? "";
      if (node.type !== "attribute") return "";
      const object = fieldChild(node, "object");
      const attribute = fieldChild(node, "attribute");
      if (!object || !attribute) return "";
      if (object.text !== "self" && object.text !== "cls") return "";
      const scoped = locals.get(`${object.text}.${attribute.text}`);
      if (scoped) return scoped;
      if (!ownerTypeId) return "";
      return fields.find((f) => f.typeId === ownerTypeId && f.name === attribute.text)?.type ?? "";
    }

    function collectLocalsAndFields(
      body: TSNode,
      locals: Map<string, string>,
      ownerId: string,
      ownerTypeId: string | null,
      params: { name: string; type: string }[]
    ): void {
      const paramNames = new Set(params.map((p) => p.name));
      walk(body, (node) => {
        if (node.type === "for_statement") {
          // `for row in self.rows:` -- the loop variable has the container's
          // element type, which is what makes `row.get(...)` resolvable.
          const left = fieldChild(node, "left");
          const iterable = fieldChild(node, "right");
          const element = elementTypeOf(
            iterable
              ? inferExpressionType(iterable) || iterableTypeOf(iterable, locals, ownerTypeId)
              : ""
          );
          if (left && element) {
            const targets = left.type === "identifier" ? [left] : left.namedChildren;
            for (const target of targets) {
              if (target.type === "identifier") locals.set(target.text, element);
            }
          }
          return;
        }
        if (node.type !== "assignment") return;
        const left = fieldChild(node, "left") ?? node.namedChildren[0];
        if (!left) return;
        const typeNode = fieldChild(node, "type");
        const right = fieldChild(node, "right");
        let inferred = typeNode ? typeText(typeNode) : inferExpressionType(right);
        // `self.repo = repo` -- the assigned value's type is the parameter's
        // declared type, which is how injected dependencies are propagated.
        if (!inferred && right && right.type === "identifier") {
          inferred = locals.get(right.text) ?? "";
        }
        if (left.type === "identifier") {
          if (!paramNames.has(left.text) && !locals.has(left.text)) {
            if (inferred) locals.set(left.text, inferred);
          }
          return;
        }
        if (left.type === "attribute" && ownerTypeId) {
          const object = fieldChild(left, "object");
          const attribute = fieldChild(left, "attribute");
          if (!object || !attribute) return;
          if (object.type !== "identifier" || (object.text !== "self" && object.text !== "cls"))
            return;
          addField(ownerTypeId, attribute.text, inferred, node.startPosition.row);
          if (inferred) locals.set(`self.${attribute.text}`, inferred);
        }
      });
      void ownerId;
    }

    // -------------------------------------------------------------- imports

    function moduleBindingOf(
      moduleText: string,
      alias: string | undefined,
      isNamespace: boolean
    ): void {
      if (!moduleText) return;
      const binding =
        alias ??
        (isNamespace
          ? (moduleText.split(".")[0] ?? moduleText)
          : (moduleText.split(".").pop() ?? moduleText));
      scopeModules.set(binding, moduleText);
    }

    function symbolBindingOf(
      moduleText: string,
      importedName: string,
      alias: string | undefined
    ): void {
      const binding = alias ?? importedName;
      if (moduleText) scopeTypes.set(binding, `${moduleText}.${importedName}`);
      else scopeTypes.set(binding, importedName);
    }

    for (const statement of root.namedChildren) {
      if (statement.type === "import_statement") {
        for (const nameNode of statement.namedChildren) {
          if (nameNode.type === "aliased_import") {
            const moduleNode = fieldChild(nameNode, "name");
            const aliasNode = fieldChild(nameNode, "alias");
            if (!moduleNode) continue;
            moduleBindingOf(moduleNode.text, aliasNode?.text, true);
            imports.push({
              fqn: moduleNode.text,
              simpleName: aliasNode?.text ?? moduleNode.text.split(".").pop() ?? moduleNode.text,
              isStatic: false,
              module: moduleNode.text,
              isNamespace: true,
              alias: aliasNode?.text,
            });
          } else if (nameNode.type === "dotted_name" || nameNode.type === "identifier") {
            moduleBindingOf(nameNode.text, undefined, true);
            imports.push({
              fqn: nameNode.text,
              simpleName: nameNode.text.split(".")[0] ?? nameNode.text,
              isStatic: false,
              module: nameNode.text,
              isNamespace: true,
            });
          }
        }
        continue;
      }
      if (statement.type !== "import_from_statement") continue;

      let level = 0;
      let moduleText = "";
      const relative = childOfType(statement, "relative_import");
      if (relative) {
        const prefix = childOfType(relative, "import_prefix");
        level = prefix ? prefix.text.length : 1;
        moduleText = childOfType(relative, "dotted_name")?.text ?? "";
      } else {
        const prefix = childOfType(statement, "import_prefix");
        if (prefix) level = prefix.text.length;
        const moduleNode =
          fieldChild(statement, "module_name") ?? childOfType(statement, "dotted_name");
        moduleText = moduleNode?.text ?? "";
      }
      if (level > 0) moduleText = resolvePythonRelative(moduleId, isPackageFile, level, moduleText);

      const moduleNode = fieldChild(statement, "module_name") ?? relative;
      const wildcard = childOfType(statement, "wildcard_import");
      if (wildcard) {
        imports.push({
          fqn: `${moduleText}.*`,
          simpleName: "*",
          isStatic: false,
          module: moduleText,
        });
        continue;
      }
      for (const nameNode of statement.namedChildren) {
        if (sameNode(nameNode, moduleNode)) continue;
        if (nameNode.type === "import_prefix" || nameNode.type === "wildcard_import") continue;
        if (nameNode.type === "aliased_import") {
          const imported = fieldChild(nameNode, "name");
          const alias = fieldChild(nameNode, "alias");
          if (!imported) continue;
          symbolBindingOf(moduleText, imported.text, alias?.text);
          imports.push({
            fqn: `${moduleText}.${imported.text}`,
            simpleName: alias?.text ?? imported.text,
            isStatic: false,
            module: moduleText,
            importedName: imported.text,
            alias: alias?.text,
          });
        } else if (nameNode.type === "dotted_name" || nameNode.type === "identifier") {
          symbolBindingOf(moduleText, nameNode.text, undefined);
          imports.push({
            fqn: `${moduleText}.${nameNode.text}`,
            simpleName: nameNode.text,
            isStatic: false,
            module: moduleText,
            importedName: nameNode.text,
          });
        }
      }
    }

    // ------------------------------------------------------- module structure
    // Runs before call-site collection so `enclosingOf` can see the type and
    // method ranges that calls are attributed to.

    for (const entry of definitionsIn(root)) {
      const annotations = annotationsOf(entry.decorators);
      if (entry.definition.type === "class_definition") {
        visitClass(entry.definition, annotations, null);
      } else if (entry.definition.type === "function_definition") {
        visitFunction(entry.definition, annotations, null, false);
      } else if (entry.definition.type === "expression_statement") {
        collectAttributeFields(entry.definition, moduleTypeId);
      }
    }

    // ------------------------------------------------------------ call sites

    function enclosingOf(line: number): { typeId: string; methodId: string } {
      let typeId = moduleTypeId;
      let typeStart = -1;
      for (const range of typeRanges) {
        if (line >= range.startLine && line <= range.endLine && range.startLine >= typeStart) {
          typeStart = range.startLine;
          typeId = range.id;
        }
      }
      let methodId = typeId;
      let methodStart = -1;
      for (const range of methodRanges) {
        if (line >= range.startLine && line <= range.endLine && range.startLine >= methodStart) {
          methodStart = range.startLine;
          methodId = range.id;
        }
      }
      return { typeId, methodId };
    }

    function recordReflection(
      call: TSNode,
      args: string[],
      enclosing: { typeId: string; methodId: string },
      mechanism: string,
      targetKind: "type" | "module" | "method",
      targetIndex: number,
      receiverIndex?: number
    ): void {
      const raw = args[targetIndex];
      if (!raw) return;
      const literal = reflectionTargetOf(raw);
      if (literal === null) return;
      reflectiveRefs.push({
        mechanism,
        targetKind,
        target: literal,
        receiver: receiverIndex !== undefined ? args[receiverIndex] : undefined,
        enclosingTypeId: enclosing.typeId,
        enclosingMethodId: enclosing.methodId,
        line: call.startPosition.row,
      });
    }

    /**
     * Extract the statically-known part of a run-time lookup target. Pure
     * literals yield the whole value; `"pkg." + name` and `f"pkg.{x}"` yield
     * the literal prefix, which is still useful for dependency reporting.
     */
    function reflectionTargetOf(raw: string): string | null {
      const trimmed = raw.trim();
      const quoted = unquote(trimmed);
      if (quoted !== trimmed) return quoted;
      const prefix = trimmed.match(/^(?:[rbfu]{0,2})?["']([^"']+)["']\s*(?:\+|%|\.format)/);
      return prefix ? (prefix[1] ?? null) : null;
    }

    walk(root, (node) => {
      if (node.type !== "call") return;
      if (insideAny(node, SKIP_CALL_ANCESTORS)) return;
      const fn = fieldChild(node, "function") ?? node.namedChildren[0];
      if (!fn) return;
      const argsNode = fieldChild(node, "arguments");
      const args = argsNode
        ? argsNode.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text)
        : [];
      const enclosing = enclosingOf(node.startPosition.row);
      const controlFlow = controlFlowOf(node, PY_FLOWS);
      const base = {
        line: node.startPosition.row,
        argumentTexts: args,
        enclosingTypeId: enclosing.typeId,
        enclosingMethodId: enclosing.methodId,
        controlFlow,
      };

      if (fn.type === "identifier") {
        const name = fn.text;
        const builtin = BUILTIN_TYPES.has(name);
        callSites.push({
          ...base,
          receiver: null,
          name,
          isConstructorCall: builtin || /^[A-Z][A-Za-z0-9_]*$/.test(name),
          qualifiedReceiver: false,
        });
        if (name === "getattr" || name === "hasattr") {
          recordReflection(node, args, enclosing, name, "method", 1, 0);
        } else if (name === "__import__") {
          recordReflection(node, args, enclosing, name, "module", 0);
        }
        return;
      }

      if (fn.type === "attribute") {
        const object = fieldChild(fn, "object");
        const attribute = fieldChild(fn, "attribute");
        if (!attribute) return;
        const receiver = object ? object.text : null;
        const name = attribute.text;
        callSites.push({
          ...base,
          receiver,
          name,
          isConstructorCall: false,
          qualifiedReceiver: !!receiver && /^[A-Z]/.test(receiver),
        });

        const rootReceiver = object ? (object.type === "identifier" ? object.text : "") : "";
        if (receiver === "importlib" && name === "import_module") {
          recordReflection(node, args, enclosing, "importlib.import_module", "module", 0);
        }
        if (receiver === "sys.modules" || receiver === "sys.modules[__name__]") {
          // `getattr(sys.modules[...], name)` is handled through getattr above.
        }
        if (HTTP_VERBS.has(name.toLowerCase()) && ROUTE_RECEIVERS.has(rootReceiver)) {
          const path = args[0] ? unquote(args[0]) : "";
          const handler = args[1] ? (args[1].split(".").pop() ?? "") : "";
          if (handler) {
            routes.push({
              framework: "http",
              httpMethod: name.toUpperCase(),
              path,
              handlerName: handler,
              moduleId,
              enclosingTypeId: enclosing.typeId,
              line: node.startPosition.row,
            });
          }
        }
        if (name === "add_url_rule" && args.length >= 3) {
          const path = unquote(args[0] ?? "");
          const handler = (args[2] ?? "").split(".").pop() ?? "";
          if (handler) {
            routes.push({
              framework: "flask",
              httpMethod: "ANY",
              path,
              handlerName: handler,
              moduleId,
              enclosingTypeId: enclosing.typeId,
              line: node.startPosition.row,
            });
          }
        }
        return;
      }

      callSites.push({
        ...base,
        receiver: fn.text,
        name: fn.text,
        isConstructorCall: false,
        qualifiedReceiver: true,
      });
    });

    let entryPoint: EntryPointInfo | undefined;
    for (const statement of root.namedChildren) {
      if (statement.type !== "if_statement") continue;
      const condition = fieldChild(statement, "condition");
      if (condition && /__name__\s*==\s*["']__main__["']/.test(condition.text)) {
        entryPoint = { kind: "cli", detail: "__main__" };
        break;
      }
    }

    tree.delete();

    return {
      filePath,
      language: "python",
      packageName: null,
      imports,
      types,
      methods,
      fields,
      callSites,
      localsByMethod,
      moduleId,
      scopeTypes,
      scopeModules,
      reflectiveRefs,
      injections,
      routes,
      entryPoint,
    };
  },
};
