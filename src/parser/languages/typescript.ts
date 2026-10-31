import { controlFlowOf, type FlowSpec, insideAny } from "../controlFlow.js";
import type {
  AnnotationInfo,
  CallSite,
  EntryPointInfo,
  FieldInfo,
  ImportInfo,
  InjectionPoint,
  LanguageDescriptor,
  MethodInfo,
  ParsedFile,
  ReflectiveRef,
  RouteRegistration,
  TypeInfo,
} from "../language.js";
import {
  DEFAULT_EXPORT_SUFFIX,
  moduleNodeId,
  resolveRelativeModule,
  tsModuleId,
} from "../moduleId.js";
import {
  childOfType,
  childrenOfType,
  createParser,
  fieldChild,
  loadGrammar,
  type TSNode,
  walk,
} from "../treeSitter.js";

/**
 * TypeScript / JavaScript parser (TS, TSX, JS, JSX).
 *
 * TypeScript has no packages either, so a module id is derived from the
 * project-relative path (`src/services/order.ts` -> `src.services.order`) and
 * module-level functions become methods of the module node. Classes,
 * interfaces, enums and object type aliases become graph types.
 *
 * Modelled beyond plain declarations:
 *  - decorators as annotations (NestJS/Angular entry points, DI, metadata)
 *  - constructor parameter properties and decorator-driven injections
 *  - express/fastify route registrations
 *  - run-time lookups (`import()`, `require`, `Reflect.get`)
 *  - control-flow context of every call site
 */

const TS_FLOWS: FlowSpec[] = [
  { type: "if_statement", kind: "branch", guardField: "condition" },
  { type: "else_clause", kind: "branch", guard: "else" },
  { type: "switch_statement", kind: "branch", guardField: "value" },
  { type: "switch_case", kind: "branch", guard: "case" },
  { type: "switch_default", kind: "branch", guard: "default" },
  { type: "ternary_expression", kind: "branch", guardField: "condition" },
  { type: "for_statement", kind: "loop", guardField: "condition" },
  { type: "for_in_statement", kind: "loop", guardField: "right" },
  { type: "while_statement", kind: "loop", guardField: "condition" },
  { type: "do_statement", kind: "loop", guardField: "condition" },
  { type: "try_statement", kind: "exception", guard: "try" },
  { type: "catch_clause", kind: "exception", guardField: "parameter" },
  { type: "finally_clause", kind: "exception", guard: "finally" },
  { type: "binary_expression", kind: "predicate", operatorIn: ["&&", "||", "??"] },
];

const SKIP_CALL_ANCESTORS = new Set(["decorator", "import_statement"]);

const HTTP_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Delete",
  "Patch",
  "Head",
  "Options",
  "All",
]);

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "all"]);

const ROUTE_RECEIVERS = new Set([
  "app",
  "router",
  "server",
  "api",
  "fastify",
  "routes",
  "express",
  "application",
]);

const PARAM_DECORATORS = new Set([
  "Body",
  "Param",
  "Query",
  "Headers",
  "Req",
  "Res",
  "Session",
  "UploadedFile",
  "UploadedFiles",
  "Ip",
  "HostParam",
]);

const INJECT_DECORATORS = new Set([
  "Inject",
  "InjectRepository",
  "InjectModel",
  "InjectDataSource",
  "Autowired",
]);

const DI_CLASS_DECORATORS = new Set([
  "Injectable",
  "Controller",
  "Component",
  "Service",
  "Directive",
  "Pipe",
  "Guard",
  "Gateway",
  "Resolver",
  "Module",
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

export const typescriptConfig: LanguageDescriptor = {
  name: "typescript",
  extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  resolver: "module",
  frameworks: ["nestjs", "nestjs-param", "ts-di", "spring", "express", "fastify"],
  fixture: ["typescript", "sample"],
  loadGrammar() {
    return loadGrammar("@vscode/tree-sitter-wasm", "wasm/tree-sitter-typescript.wasm");
  },
  async parseFile(source, filePath, context): Promise<ParsedFile> {
    const usesTsxGrammar = /\.(tsx|jsx|js|mjs|cjs)$/i.test(filePath);
    const grammar = await loadGrammar(
      "@vscode/tree-sitter-wasm",
      usesTsxGrammar ? "wasm/tree-sitter-tsx.wasm" : "wasm/tree-sitter-typescript.wasm"
    );
    const parser = createParser(grammar);
    const tree = parser.parse(source);
    if (!tree) throw new Error(`failed to parse ${filePath}`);
    const root = tree.rootNode;

    const moduleId = tsModuleId(filePath, context?.projectRoot);
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
    const externalModules = new Map<string, string>();
    const reflectiveRefs: ReflectiveRef[] = [];
    const injections: InjectionPoint[] = [];
    const routes: RouteRegistration[] = [];

    const methodRanges: MethodRange[] = [];
    const typeRanges: TypeRange[] = [
      { startLine: 0, endLine: root.endPosition.row, id: moduleTypeId },
    ];
    const fieldIds = new Set<string>();
    let defaultExportName: string | undefined;

    // ---------------------------------------------------------------- helpers

    function stringContent(raw: string): string {
      const trimmed = raw.trim();
      const match = trimmed.match(/^["'`]([\s\S]*?)["'`]$/);
      return match ? (match[1] ?? "") : trimmed;
    }

    function typeNameOf(node: TSNode | null): string {
      if (!node) return "";
      switch (node.type) {
        case "identifier":
        case "type_identifier":
        case "property_identifier":
        case "nested_type_identifier":
          return node.text;
        case "generic_type": {
          const name = fieldChild(node, "name") ?? node.namedChildren[0];
          return name ? name.text : node.text;
        }
        case "member_expression": {
          const property = fieldChild(node, "property");
          return property ? property.text : node.text;
        }
        case "call_expression": {
          const fn = fieldChild(node, "function") ?? node.namedChildren[0];
          return typeNameOf(fn ?? null);
        }
        case "type_annotation":
          return typeNameOf(node.namedChildren[0] ?? null);
        default:
          return (node.text.split("<")[0] ?? "").trim();
      }
    }

    function annotationTypeText(node: TSNode | null): string {
      if (!node) return "";
      return node.text.replace(/^\s*:\s*/, "").trim();
    }

    function decoratorName(node: TSNode): { name: string; fqn?: string } | null {
      const expression = node.namedChildren[0] ?? null;
      if (!expression) return null;
      if (expression.type === "call_expression") {
        const fn = fieldChild(expression, "function") ?? expression.namedChildren[0];
        if (!fn) return null;
        if (fn.type === "identifier") return { name: fn.text };
        if (fn.type === "member_expression") {
          const property = fieldChild(fn, "property");
          if (!property) return null;
          return { name: property.text, fqn: fn.text };
        }
        return { name: fn.text };
      }
      if (expression.type === "identifier") return { name: expression.text };
      if (expression.type === "member_expression") {
        const property = fieldChild(expression, "property");
        if (!property) return null;
        return { name: property.text, fqn: expression.text };
      }
      return null;
    }

    function annotationOf(node: TSNode): AnnotationInfo | null {
      const named = decoratorName(node);
      if (!named) return null;
      let args: string[] = [];
      const expression = node.namedChildren[0];
      if (expression && expression.type === "call_expression") {
        const argsNode = fieldChild(expression, "arguments");
        if (argsNode) {
          args = argsNode.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text);
        }
      }
      return { name: named.name, fqn: named.fqn, arguments: args, line: node.startPosition.row };
    }

    function annotationsOf(decorators: TSNode[]): AnnotationInfo[] {
      return decorators.map((d) => annotationOf(d)).filter((a): a is AnnotationInfo => a !== null);
    }

    function annotationString(annotation: AnnotationInfo): string {
      for (const arg of annotation.arguments) {
        const value = stringContent(arg);
        if (value !== arg.trim()) return value;
      }
      return "";
    }

    function joinPath(base: string, suffix: string): string {
      const joined = `${base}/${suffix}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
      return joined === "" ? "/" : joined.startsWith("/") ? joined : `/${joined}`;
    }

    function entryPointOf(
      annotations: AnnotationInfo[],
      controllerPath: string,
      name: string
    ): EntryPointInfo | undefined {
      for (const annotation of annotations) {
        const simple = annotation.name;
        if (HTTP_DECORATORS.has(simple)) {
          const path = annotationString(annotation);
          return {
            kind: "http",
            detail: `${simple.toUpperCase()} ${joinPath(controllerPath, path)}`.trim(),
          };
        }
        if (simple === "MessagePattern" || simple === "EventPattern" || simple === "OnMessage") {
          return { kind: "messaging", detail: `${simple} ${annotationString(annotation)}`.trim() };
        }
        if (simple === "Cron" || simple === "Interval" || simple === "Timeout") {
          const first = annotation.arguments[0] ? stringContent(annotation.arguments[0]) : "";
          return { kind: "scheduler", detail: `${simple} ${first}`.trim() };
        }
        if (simple === "OnEvent" || simple === "EventSubscriber" || simple === "SubscribeMessage") {
          return { kind: "event", detail: simple };
        }
        if (simple === "Test" || simple === "It") return { kind: "test", detail: simple };
      }
      if (/^(test|it)$/i.test(name)) return { kind: "test", detail: name };
      return undefined;
    }

    function inferExpressionType(node: TSNode | null): string {
      if (!node) return "";
      switch (node.type) {
        case "new_expression": {
          const ctor = fieldChild(node, "constructor") ?? node.namedChildren[0];
          return typeNameOf(ctor ?? null);
        }
        case "call_expression": {
          const fn = fieldChild(node, "function") ?? node.namedChildren[0];
          if (!fn) return "";
          const name = typeNameOf(fn);
          return /^[A-Z]/.test(name) ? name : "";
        }
        case "string":
          return "string";
        case "number":
          return "number";
        case "true":
        case "false":
          return "boolean";
        case "array":
          return "Array";
        case "object":
          return "object";
        case "arrow_function":
        case "function_expression":
          return "";
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

    function parseParams(paramsNode: TSNode | null): { name: string; type: string }[] {
      if (!paramsNode) return [];
      const out: { name: string; type: string }[] = [];
      for (const param of paramsNode.namedChildren) {
        if (param.type === "required_parameter" || param.type === "optional_parameter") {
          const pattern = fieldChild(param, "pattern") ?? param.namedChildren[0];
          if (pattern) {
            out.push({
              name: pattern.text.replace(/\s+/g, " "),
              type: annotationTypeText(fieldChild(param, "type")),
            });
          }
        } else if (param.type === "identifier") {
          out.push({ name: param.text, type: "" });
        } else if (param.type === "rest_pattern") {
          out.push({ name: param.text, type: "" });
        } else if (param.type === "object_pattern" || param.type === "array_pattern") {
          out.push({ name: param.text.replace(/\s+/g, " "), type: "" });
        } else if (param.type !== "comment") {
          out.push({ name: param.text.replace(/\s+/g, " "), type: "" });
        }
      }
      return out;
    }

    /** True when a parameter list ends in `...rest`. */
    function isVariadicParams(paramsNode: TSNode | null): boolean {
      if (!paramsNode) return false;
      // A typed rest parameter is a `required_parameter` wrapping a
      // `rest_pattern`; an untyped one appears as a bare `rest_pattern`.
      return paramsNode.namedChildren.some(
        (param) =>
          param.type === "rest_pattern" ||
          (fieldChild(param, "pattern") ?? param.namedChildren[0])?.type === "rest_pattern"
      );
    }

    function modifiersOf(node: TSNode): string[] {
      const modifiers: string[] = [];
      for (const child of node.children) {
        switch (child.type) {
          case "accessibility_modifier":
          case "static":
          case "async":
          case "get":
          case "set":
          case "abstract":
          case "override":
          case "readonly":
          case "declare":
            if (!modifiers.includes(child.type)) modifiers.push(child.type);
            break;
          default:
            break;
        }
      }
      if (node.type === "public_field_definition") modifiers.push("field");
      return modifiers;
    }

    // ---------------------------------------------------------- declarations

    function heritageOf(node: TSNode): { extendsTypes: string[]; implementsTypes: string[] } {
      const extendsTypes: string[] = [];
      const implementsTypes: string[] = [];
      const heritage = childOfType(node, "class_heritage");
      if (!heritage) return { extendsTypes, implementsTypes };
      for (const clause of childrenOfType(heritage, "extends_clause")) {
        for (const value of clause.namedChildren) {
          if (value.type === "type_arguments") continue;
          extendsTypes.push(typeNameOf(value));
        }
      }
      for (const clause of childrenOfType(heritage, "implements_clause")) {
        for (const value of clause.namedChildren) implementsTypes.push(typeNameOf(value));
      }
      return { extendsTypes, implementsTypes };
    }

    function visitClass(
      node: TSNode,
      decorators: AnnotationInfo[],
      parentTypeId: string | null,
      exported: boolean
    ): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "type_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const id = parentTypeId ? `${parentTypeId}.${name}` : `${moduleId}.${name}`;
      const { extendsTypes, implementsTypes } = heritageOf(node);
      const annotations = decorators;
      types.push({
        id,
        kind: "class",
        name,
        extendsTypes,
        implementsTypes,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        annotations,
        isAspect: annotations.some((a) => a.name === "Aspect"),
        exported,
      });
      typeRanges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, id });
      scopeTypes.set(name, id);

      const injectable = annotations.some((a) => DI_CLASS_DECORATORS.has(a.name));
      const controller = annotations.find((a) => a.name === "Controller");
      const controllerPath = controller ? annotationString(controller) : "";

      const body = fieldChild(node, "body") ?? childOfType(node, "class_body");
      if (!body) return;

      const buffer: TSNode[] = [];
      for (const member of body.namedChildren) {
        if (member.type === "decorator") {
          buffer.push(member);
          continue;
        }
        const memberDecorators = buffer.splice(0, buffer.length);
        for (const fieldDecorator of childrenOfType(member, "decorator"))
          memberDecorators.push(fieldDecorator);
        const memberAnnotations = annotationsOf(memberDecorators);
        if (member.type === "method_definition") {
          visitMethod(member, memberAnnotations, id, injectable, controllerPath);
        } else if (member.type === "public_field_definition") {
          visitClassField(member, memberAnnotations, id, injectable);
        } else if (
          member.type === "abstract_method_signature" ||
          member.type === "method_signature"
        ) {
          visitSignature(member, memberAnnotations, id, controllerPath);
        } else if (
          member.type === "class_declaration" ||
          member.type === "abstract_class_declaration"
        ) {
          visitClass(member, memberAnnotations, id, true);
        }
      }
    }

    function visitClassField(
      node: TSNode,
      annotations: AnnotationInfo[],
      classId: string,
      injectable: boolean
    ): void {
      const nameNode =
        fieldChild(node, "name") ??
        node.namedChildren.find((c) => c.type === "property_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const declared = annotationTypeText(fieldChild(node, "type"));
      const value = fieldChild(node, "value");

      if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
        visitCallable({
          name,
          node,
          paramsNode: fieldChild(value, "parameters") ?? childOfType(value, "formal_parameters"),
          returnTypeNode: fieldChild(value, "return_type"),
          bodyNode: fieldChild(value, "body"),
          annotations,
          ownerTypeId: classId,
          extraModifiers: modifiersOf(node),
          injectable,
          isConstructor: false,
        });
        return;
      }

      addField(
        classId,
        name,
        declared || inferExpressionType(value),
        node.startPosition.row,
        annotations
      );

      const injectDecorator = annotations.find((a) => INJECT_DECORATORS.has(a.name));
      if (injectDecorator || (injectable && !declared)) {
        injections.push({
          kind: "field",
          ownerId: classId,
          name,
          type: declared || (injectDecorator?.arguments[0] ?? "").trim(),
          framework: injectDecorator?.name === "Autowired" ? "spring" : "nestjs",
          line: node.startPosition.row,
        });
      }
    }

    function visitMethod(
      node: TSNode,
      annotations: AnnotationInfo[],
      classId: string,
      injectable: boolean,
      controllerPath: string
    ): void {
      const nameNode =
        fieldChild(node, "name") ??
        node.namedChildren.find((c) => c.type === "property_identifier");
      if (!nameNode) return;
      const rawName = nameNode.text;
      visitCallable({
        name: rawName,
        node,
        paramsNode: fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters"),
        returnTypeNode: fieldChild(node, "return_type"),
        bodyNode: fieldChild(node, "body") ?? childOfType(node, "statement_block"),
        annotations,
        ownerTypeId: classId,
        extraModifiers: modifiersOf(node),
        entryPoint: entryPointOf(annotations, controllerPath, rawName),
        injectable,
        isConstructor: rawName === "constructor",
      });
      for (const annotation of annotations) {
        if (!HTTP_DECORATORS.has(annotation.name)) continue;
        routes.push({
          framework: "nestjs",
          httpMethod: annotation.name.toUpperCase(),
          path: joinPath(controllerPath, annotationString(annotation)),
          handlerName: rawName,
          moduleId,
          enclosingTypeId: classId,
          line: annotation.line,
        });
      }
    }

    function visitSignature(
      node: TSNode,
      annotations: AnnotationInfo[],
      classId: string,
      controllerPath: string
    ): void {
      const nameNode =
        fieldChild(node, "name") ??
        node.namedChildren.find((c) => c.type === "property_identifier");
      if (!nameNode) return;
      const rawName = nameNode.text;
      const id = `${classId}#${rawName}`;
      const signatureParams =
        fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters");
      methods.push({
        id,
        typeId: classId,
        name: rawName,
        isConstructor: false,
        params: parseParams(signatureParams),
        variadic: isVariadicParams(signatureParams),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        returnType: annotationTypeText(fieldChild(node, "return_type")),
        modifiers: modifiersOf(node),
        annotations,
        entryPoint: entryPointOf(annotations, controllerPath, rawName),
      });
      methodRanges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        id,
        typeId: classId,
      });
    }

    function visitCallable(options: {
      name: string;
      node: TSNode;
      paramsNode: TSNode | null;
      returnTypeNode: TSNode | null;
      bodyNode: TSNode | null;
      annotations: AnnotationInfo[];
      ownerTypeId: string;
      extraModifiers: string[];
      entryPoint?: EntryPointInfo;
      injectable: boolean;
      isConstructor: boolean;
    }): void {
      const { name, node, paramsNode, returnTypeNode, bodyNode, annotations, ownerTypeId } =
        options;
      const isConstructor = options.isConstructor;
      const id = `${ownerTypeId}#${isConstructor ? "<init>" : name}`;
      const params = parseParams(paramsNode);

      methods.push({
        id,
        typeId: ownerTypeId,
        name: isConstructor ? "<init>" : name,
        isConstructor,
        params,
        variadic: isVariadicParams(paramsNode),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        returnType: annotationTypeText(returnTypeNode),
        modifiers: options.extraModifiers,
        annotations,
        entryPoint: options.entryPoint,
      });
      methodRanges.push({
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        id,
        typeId: ownerTypeId,
      });

      const locals = new Map<string, string>();
      for (const param of params) {
        if (param.type) locals.set(param.name.replace(/\?$/, ""), param.type);
      }

      collectParamInjections(paramsNode, ownerTypeId, isConstructor, options.injectable);

      if (bodyNode) collectLocals(bodyNode, locals, ownerTypeId);
      localsByMethod.set(id, locals);
    }

    function collectParamInjections(
      paramsNode: TSNode | null,
      ownerTypeId: string,
      isConstructor: boolean,
      injectable: boolean
    ): void {
      if (!paramsNode) return;
      for (const param of paramsNode.namedChildren) {
        if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
        const pattern = fieldChild(param, "pattern") ?? param.namedChildren[0];
        if (!pattern) continue;
        const name = pattern.text.replace(/\s+/g, " ");
        const declared = annotationTypeText(fieldChild(param, "type"));
        const hasPropertyModifier = param.children.some((c) => c.type === "accessibility_modifier");
        const paramDecorators = childrenOfType(param, "decorator")
          .map((d) => decoratorName(d))
          .filter((d): d is { name: string; fqn?: string } => d !== null);

        if (isConstructor && hasPropertyModifier) {
          addField(ownerTypeId, name, declared, param.startPosition.row);
        }

        const injectDecorator = paramDecorators.find((d) => INJECT_DECORATORS.has(d.name));
        const bindingDecorator = paramDecorators.find((d) => PARAM_DECORATORS.has(d.name));
        if (injectDecorator) {
          const decoratorNode = childrenOfType(param, "decorator").find(
            (d) => decoratorName(d)?.name === injectDecorator.name
          );
          const annotation = decoratorNode ? annotationOf(decoratorNode) : null;
          injections.push({
            kind: isConstructor ? "constructor-parameter" : "parameter",
            ownerId: ownerTypeId,
            name,
            type: declared || (annotation?.arguments[0] ?? "").trim(),
            framework: "nestjs",
            line: param.startPosition.row,
          });
          continue;
        }
        if (bindingDecorator) {
          injections.push({
            kind: "parameter",
            ownerId: ownerTypeId,
            name,
            type: declared || bindingDecorator.name,
            framework: "nestjs-param",
            line: param.startPosition.row,
          });
          continue;
        }
        if (isConstructor && (hasPropertyModifier || injectable) && declared) {
          injections.push({
            kind: "constructor-parameter",
            ownerId: ownerTypeId,
            name,
            type: declared,
            framework: "ts-di",
            line: param.startPosition.row,
          });
        }
      }
    }

    function collectLocals(body: TSNode, locals: Map<string, string>, classId: string): void {
      walk(body, (node) => {
        if (node.type === "variable_declarator") {
          const nameNode = fieldChild(node, "name");
          if (!nameNode) return;
          const declared = annotationTypeText(fieldChild(node, "type"));
          const value = fieldChild(node, "value");
          const inferred = declared || inferExpressionType(value);
          if (nameNode.type === "identifier" && inferred) locals.set(nameNode.text, inferred);
          return;
        }
        if (node.type === "assignment_expression") {
          const left = fieldChild(node, "left");
          const right = fieldChild(node, "right");
          if (!left || !right || left.type !== "member_expression") return;
          const object = fieldChild(left, "object");
          const property = fieldChild(left, "property");
          if (!object || !property) return;
          if (object.type !== "this" && object.text !== "this") return;
          const inferred = inferExpressionType(right);
          if (inferred) {
            addField(classId, property.text, inferred, node.startPosition.row);
            locals.set(`this.${property.text}`, inferred);
          }
          return;
        }
        if (node.type === "catch_clause") {
          const param = fieldChild(node, "parameter");
          const type = annotationTypeText(fieldChild(node, "type"));
          if (param && param.type === "identifier" && type) locals.set(param.text, type);
        }
      });
    }

    function visitInterface(node: TSNode, decorators: AnnotationInfo[], exported: boolean): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "type_identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const id = `${moduleId}.${name}`;
      const extendsTypes: string[] = [];
      for (const clause of childrenOfType(node, "extends_type_clause")) {
        for (const value of clause.namedChildren) extendsTypes.push(typeNameOf(value));
      }
      types.push({
        id,
        kind: "interface",
        name,
        extendsTypes,
        implementsTypes: [],
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        annotations: decorators,
        exported,
      });
      typeRanges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, id });
      scopeTypes.set(name, id);

      const body = fieldChild(node, "body") ?? childOfType(node, "interface_body");
      if (!body) return;
      for (const member of body.namedChildren) {
        if (member.type === "method_signature" || member.type === "abstract_method_signature") {
          visitSignature(member, [], id, "");
        }
      }
    }

    function visitTypeAlias(node: TSNode, decorators: AnnotationInfo[], exported: boolean): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "type_identifier");
      const value =
        fieldChild(node, "value") ?? node.namedChildren.find((c) => c.type === "object_type");
      if (!nameNode || !value || value.type !== "object_type") return;
      const name = nameNode.text;
      const id = `${moduleId}.${name}`;
      types.push({
        id,
        kind: "interface",
        name,
        extendsTypes: [],
        implementsTypes: [],
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        annotations: decorators,
        exported,
      });
      typeRanges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, id });
      scopeTypes.set(name, id);
      for (const member of value.namedChildren) {
        if (member.type === "method_signature") visitSignature(member, [], id, "");
      }
    }

    function visitEnum(node: TSNode, decorators: AnnotationInfo[], exported: boolean): void {
      const nameNode = fieldChild(node, "name") ?? childOfType(node, "identifier");
      if (!nameNode) return;
      const name = nameNode.text;
      const id = `${moduleId}.${name}`;
      types.push({
        id,
        kind: "enum",
        name,
        extendsTypes: [],
        implementsTypes: [],
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        annotations: decorators,
        exported,
      });
      typeRanges.push({ startLine: node.startPosition.row, endLine: node.endPosition.row, id });
      scopeTypes.set(name, id);
    }

    function visitFunctionDeclaration(node: TSNode, decorators: AnnotationInfo[]): void {
      const nameNode = fieldChild(node, "name");
      if (!nameNode) return;
      visitCallable({
        name: nameNode.text,
        node,
        paramsNode: fieldChild(node, "parameters") ?? childOfType(node, "formal_parameters"),
        returnTypeNode: fieldChild(node, "return_type"),
        bodyNode: fieldChild(node, "body") ?? childOfType(node, "statement_block"),
        annotations: decorators,
        ownerTypeId: moduleTypeId,
        extraModifiers: modifiersOf(node),
        entryPoint: entryPointOf(decorators, "", nameNode.text),
        injectable: false,
        isConstructor: false,
      });
    }

    function visitLexicalDeclaration(node: TSNode, decorators: AnnotationInfo[]): void {
      for (const declarator of childrenOfType(node, "variable_declarator")) {
        const nameNode = fieldChild(declarator, "name");
        if (!nameNode) continue;
        const declared = annotationTypeText(fieldChild(declarator, "type"));
        const value = fieldChild(declarator, "value");
        if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
          visitCallable({
            name: nameNode.text,
            node: declarator,
            paramsNode: fieldChild(value, "parameters") ?? childOfType(value, "formal_parameters"),
            returnTypeNode: fieldChild(value, "return_type"),
            bodyNode: fieldChild(value, "body"),
            annotations: decorators,
            ownerTypeId: moduleTypeId,
            extraModifiers: ["const"],
            entryPoint: entryPointOf(decorators, "", nameNode.text),
            injectable: false,
            isConstructor: false,
          });
          continue;
        }
        if (nameNode.type !== "identifier") continue;
        const inferred = declared || inferExpressionType(value);
        addField(moduleTypeId, nameNode.text, inferred, declarator.startPosition.row, decorators);
        if (inferred && inferred !== nameNode.text) scopeTypes.set(nameNode.text, inferred);
      }
    }

    // -------------------------------------------------------------- imports

    function addImport(entry: ImportInfo): void {
      imports.push(entry);
    }

    function bindModule(binding: string, candidate: string, external: boolean): void {
      if (external) {
        externalModules.set(binding, candidate);
        return;
      }
      scopeModules.set(binding, candidate);
    }

    function bindSymbol(binding: string, candidate: string, specificModule: string | null): void {
      if (specificModule === null) {
        externalModules.set(binding, candidate);
        return;
      }
      scopeTypes.set(binding, candidate);
    }

    function stripSpecifierExtension(specifier: string): string {
      return specifier.replace(/\.(m|c)?[jt]sx?$/, "");
    }

    function normalizeResolved(candidate: string): string {
      return candidate.replace(/\.(index|mod)$/, "");
    }

    function handleImportStatement(node: TSNode): void {
      const sourceNode = fieldChild(node, "source") ?? childOfType(node, "string");
      if (!sourceNode) return;
      const specifier = stringContent(sourceNode.text);
      const isRelative = specifier.startsWith(".");
      const aliasMatch = specifier.startsWith("@/") || specifier.startsWith("~/");
      const candidateModule = isRelative
        ? normalizeResolved(
            resolveRelativeModule(moduleId, stripSpecifierExtension(specifier)) ?? specifier
          )
        : aliasMatch
          ? specifier.slice(2).replace(/\//g, ".")
          : specifier;
      const external = !isRelative && !aliasMatch;
      const moduleCandidate = aliasMatch ? `?suffix:${candidateModule}` : candidateModule;

      const clause = childOfType(node, "import_clause");
      if (!clause) {
        addImport({
          fqn: specifier,
          simpleName: specifier,
          isStatic: false,
          module: candidateModule,
          external,
        });
        return;
      }

      for (const child of clause.namedChildren) {
        if (child.type === "identifier") {
          const binding = child.text;
          bindSymbol(
            binding,
            external ? specifier : `${moduleCandidate}${DEFAULT_EXPORT_SUFFIX}`,
            external ? null : moduleCandidate
          );
          addImport({
            fqn: external ? `${specifier}.default` : `${candidateModule}.default`,
            simpleName: binding,
            isStatic: false,
            module: candidateModule,
            importedName: "default",
            external,
          });
        } else if (child.type === "namespace_import") {
          const nameNode = childOfType(child, "identifier");
          if (!nameNode) continue;
          bindModule(nameNode.text, moduleCandidate, external);
          addImport({
            fqn: candidateModule,
            simpleName: nameNode.text,
            isStatic: false,
            module: candidateModule,
            isNamespace: true,
            alias: nameNode.text,
            external,
          });
        } else if (child.type === "named_imports") {
          for (const specifierNode of childrenOfType(child, "import_specifier")) {
            const nameNode = fieldChild(specifierNode, "name") ?? specifierNode.namedChildren[0];
            const aliasNode = fieldChild(specifierNode, "alias");
            if (!nameNode) continue;
            const importedName = nameNode.text;
            const binding = aliasNode?.text ?? importedName;
            bindSymbol(
              binding,
              external ? specifier : `${moduleCandidate}.${importedName}`,
              external ? null : moduleCandidate
            );
            addImport({
              fqn: external ? `${specifier}.${importedName}` : `${candidateModule}.${importedName}`,
              simpleName: binding,
              isStatic: false,
              module: candidateModule,
              importedName,
              alias: aliasNode?.text,
              external,
            });
          }
        }
      }
    }

    // ------------------------------------------------- top-level declarations

    function handleDeclaration(
      node: TSNode,
      decorators: AnnotationInfo[],
      exported: boolean
    ): void {
      switch (node.type) {
        case "class_declaration":
        case "abstract_class_declaration":
          visitClass(node, decorators, null, exported);
          break;
        case "interface_declaration":
          visitInterface(node, decorators, exported);
          break;
        case "enum_declaration":
          visitEnum(node, decorators, exported);
          break;
        case "type_alias_declaration":
          visitTypeAlias(node, decorators, exported);
          break;
        case "function_declaration":
        case "generator_function_declaration":
          visitFunctionDeclaration(node, decorators);
          break;
        case "lexical_declaration":
          visitLexicalDeclaration(node, decorators);
          break;
        default:
          break;
      }
    }

    const programBuffer: TSNode[] = [];
    for (const child of root.namedChildren) {
      if (child.type === "decorator") {
        programBuffer.push(child);
        continue;
      }
      if (child.type === "import_statement") {
        handleImportStatement(child);
        continue;
      }
      if (child.type === "export_statement") {
        const declaration = fieldChild(child, "declaration");
        const decorators = [
          ...programBuffer.splice(0, programBuffer.length),
          ...childrenOfType(child, "decorator"),
        ];
        if (declaration) {
          handleDeclaration(declaration, annotationsOf(decorators), true);
          if (/^\s*export\s+default\b/.test(child.text)) {
            const nameNode = fieldChild(declaration, "name");
            if (nameNode) defaultExportName = nameNode.text;
          }
        } else {
          const value =
            fieldChild(child, "value") ?? child.namedChildren.find((c) => c.type === "identifier");
          if (value && (value.type === "identifier" || value.type === "member_expression")) {
            defaultExportName = value.text.split(".").pop() ?? value.text;
          }
          for (const clause of childrenOfType(child, "export_clause")) {
            for (const spec of childrenOfType(clause, "export_specifier")) {
              const name = fieldChild(spec, "name");
              const alias = fieldChild(spec, "alias");
              if (name) scopeTypes.set(alias?.text ?? name.text, `${moduleId}.${name.text}`);
            }
          }
        }
        continue;
      }
      const decorators = programBuffer.splice(0, programBuffer.length);
      handleDeclaration(child, annotationsOf(decorators), false);
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

    walk(root, (node) => {
      if (node.type !== "call_expression" && node.type !== "new_expression") return;
      if (insideAny(node, SKIP_CALL_ANCESTORS)) return;

      const enclosing = enclosingOf(node.startPosition.row);
      const controlFlow = controlFlowOf(node, TS_FLOWS);
      const argsNode = fieldChild(node, "arguments");
      const args = argsNode
        ? argsNode.namedChildren.filter((c) => c.type !== "comment").map((c) => c.text)
        : [];
      const base = {
        line: node.startPosition.row,
        argumentTexts: args,
        enclosingTypeId: enclosing.typeId,
        enclosingMethodId: enclosing.methodId,
        controlFlow,
      };

      if (node.type === "new_expression") {
        const ctor = fieldChild(node, "constructor") ?? node.namedChildren[0];
        callSites.push({
          ...base,
          receiver: null,
          name: typeNameOf(ctor ?? null),
          isConstructorCall: true,
          qualifiedReceiver: false,
        });
        return;
      }

      const fn = fieldChild(node, "function") ?? node.namedChildren[0];
      if (!fn) return;

      // Dynamic import is a run-time module lookup, not a normal call.
      if (fn.type === "import") {
        const target = args[0] ? stringContent(args[0]) : "";
        if (target) {
          reflectiveRefs.push({
            mechanism: "import()",
            targetKind: "module",
            target,
            enclosingTypeId: enclosing.typeId,
            enclosingMethodId: enclosing.methodId,
            line: node.startPosition.row,
          });
        }
        return;
      }

      if (fn.type === "identifier") {
        const name = fn.text;
        callSites.push({
          ...base,
          receiver: null,
          name,
          isConstructorCall: /^[A-Z]/.test(name),
          qualifiedReceiver: false,
        });
        if (name === "require" && args[0]) {
          const target = stringContent(args[0]);
          if (target) {
            reflectiveRefs.push({
              mechanism: "require",
              targetKind: "module",
              target,
              enclosingTypeId: enclosing.typeId,
              enclosingMethodId: enclosing.methodId,
              line: node.startPosition.row,
            });
          }
        }
        return;
      }

      if (fn.type === "member_expression") {
        const object = fieldChild(fn, "object");
        const property = fieldChild(fn, "property");
        if (!property) return;
        let receiver = object ? object.text : null;
        if (receiver?.endsWith("!")) receiver = receiver.slice(0, -1);
        const name = property.text;
        callSites.push({
          ...base,
          receiver,
          name,
          isConstructorCall: false,
          qualifiedReceiver: !!receiver && /^[A-Z]/.test(receiver),
        });

        if (object && object.type === "identifier" && object.text === "Reflect") {
          const target = args[1] ? stringContent(args[1]) : "";
          if (target && args[1] && target !== args[1].trim()) {
            reflectiveRefs.push({
              mechanism: `Reflect.${name}`,
              targetKind: "method",
              target,
              receiver: args[0],
              enclosingTypeId: enclosing.typeId,
              enclosingMethodId: enclosing.methodId,
              line: node.startPosition.row,
            });
          }
        }

        const rootReceiver = object
          ? object.type === "identifier"
            ? object.text
            : object.type === "this"
              ? "this"
              : ""
          : "";
        if (
          HTTP_METHODS.has(name.toLowerCase()) &&
          ROUTE_RECEIVERS.has(rootReceiver) &&
          args.length >= 2
        ) {
          const path = stringContent(args[0] ?? "");
          const handlerNode = argsNode?.namedChildren[1] ?? null;
          // Only a plain reference names a handler; anything else (arrow,
          // function expression) is an inline root we index synthetically.
          let handler = "";
          if (
            handlerNode &&
            (handlerNode.type === "identifier" || handlerNode.type === "member_expression")
          ) {
            handler = typeNameOf(handlerNode);
          }
          if (
            !handler &&
            handlerNode &&
            (handlerNode.type === "arrow_function" || handlerNode.type === "function_expression")
          ) {
            // Inline handlers are framework-invoked roots with no source name,
            // so give them a stable synthetic id and index them as methods.
            handler = `<anonymous@${node.startPosition.row + 1}>`;
            visitCallable({
              name: handler,
              node: handlerNode,
              paramsNode:
                fieldChild(handlerNode, "parameters") ??
                childOfType(handlerNode, "formal_parameters"),
              returnTypeNode: fieldChild(handlerNode, "return_type"),
              bodyNode: fieldChild(handlerNode, "body"),
              annotations: [],
              ownerTypeId: moduleTypeId,
              extraModifiers: ["inline"],
              entryPoint: { kind: "http", detail: `${name.toUpperCase()} ${path}`.trim() },
              injectable: false,
              isConstructor: false,
            });
          }
          if (handler) {
            routes.push({
              framework: rootReceiver === "fastify" ? "fastify" : "express",
              httpMethod: name.toUpperCase(),
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
        name: typeNameOf(fn) || fn.text,
        isConstructorCall: false,
        qualifiedReceiver: true,
      });
    });

    tree.delete();

    return {
      filePath,
      language: "typescript",
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
      externalModules,
      defaultExportName,
      reflectiveRefs,
      injections,
      routes,
    };
  },
};
