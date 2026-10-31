import { describe, expect, it } from "vitest";
import type { ParsedFile } from "../src/parser/language.js";
import { pythonConfig } from "../src/parser/languages/python.js";
import { typescriptConfig } from "../src/parser/languages/typescript.js";
import {
  resolveGenericFile,
  resolveInjectionTarget,
  resolveReflectiveTarget,
  resolveRouteHandler,
} from "../src/resolver/genericResolver.js";
import type { ResolvedCall, TypeIndex } from "../src/resolver/types.js";
import { buildTypeIndex } from "../src/resolver/types.js";

const ROOT = "/tmp/proj";

/** Shared TS project: a service, and a holder that reaches it through a field. */
async function tsProject() {
  return project("typescript", {
    "src/svc.ts": `export class Service { work(): void {} }
export function makeService(): void {}`,
    "src/app.ts": `import { Service } from "./svc";
export class Holder {
  svc: Service = new Service();
  run(): void { this.svc.work(); }
}`,
  });
}

interface Project {
  files: ParsedFile[];
  index: TypeIndex;
  file(moduleId: string): ParsedFile;
  /** Resolutions for every call site in `moduleId`. */
  calls(moduleId: string): ResolvedCall[];
  /** The single resolution of `name` in `moduleId`. */
  call(moduleId: string, name: string): ResolvedCall;
}

async function project(
  language: "typescript" | "python",
  sources: Record<string, string>
): Promise<Project> {
  const config = language === "typescript" ? typescriptConfig : pythonConfig;
  const files = await Promise.all(
    Object.entries(sources).map(([rel, source]) =>
      config.parseFile(source, `${ROOT}/${rel}`, { projectRoot: ROOT })
    )
  );
  const index = buildTypeIndex(files);
  const fileOf = (moduleId: string): ParsedFile => {
    const found = files.find((f) => f.moduleId === moduleId);
    if (!found) throw new Error(`no module ${moduleId} in ${files.map((f) => f.moduleId).join()}`);
    return found;
  };
  return {
    files,
    index,
    file: fileOf,
    calls: (moduleId) => resolveGenericFile(fileOf(moduleId), index),
    call: (moduleId, name) => {
      const matches = resolveGenericFile(fileOf(moduleId), index).filter(
        (r) => r.callSite.name === name
      );
      if (matches.length !== 1) {
        throw new Error(`expected 1 call to ${name} in ${moduleId}, got ${matches.length}`);
      }
      return matches[0] as ResolvedCall;
    },
  };
}

describe("generic resolver — receiver and bare-call dispatch", () => {
  it("binds a bare call to a function in the same module", async () => {
    const p = await project("typescript", {
      "src/a.ts": `export function helper(): void {}
export function caller(): void { helper(); }`,
    });
    const r = p.call("src.a", "helper");
    expect(r.targetId).toBe("module:src.a#helper");
    expect(r.resolved).toBe(true);
    expect(r.confidence).toBe(0.9);
    expect(r.reason).toContain("declared on module:src.a");
  });

  it("routes a method call on a typed local to the declaring type", async () => {
    const p = await project("typescript", {
      "src/svc.ts": `export class Service { work(): void {} }`,
      "src/use.ts": `import { Service } from "./svc";
export function main(): void {
  const s = new Service();
  s.work();
}`,
    });
    const r = p.call("src.use", "work");
    expect(r.targetId).toBe("src.svc.Service#work");
    expect(r.confidence).toBe(0.9);
    expect(r.reason).toContain("declared on src.svc.Service");
  });

  it("marks an inherited method as less certain than an own method", async () => {
    const p = await project("typescript", {
      "src/a.ts": `export class Base { hello(): void {} }
export class Sub extends Base {
  run(): void { this.hello(); }
}`,
    });
    const r = p.call("src.a", "hello");
    expect(r.targetId).toBe("src.a.Base#hello");
    expect(r.confidence).toBe(0.8);
    expect(r.reason).toContain("inherited from src.a.Base");
  });

  it("resolves a function imported from another module", async () => {
    const p = await project("typescript", {
      "src/svc.ts": `export function makeService(): void {}`,
      "src/use.ts": `import { makeService } from "./svc";
export function main(): void { makeService(); }`,
    });
    const r = p.call("src.use", "makeService");
    expect(r.targetId).toBe("module:src.svc#makeService");
    expect(r.confidence).toBe(0.85);
    expect(r.reason).toContain("imported from src.svc");
  });

  it("records an external receiver as an ext: edge, never a phantom", async () => {
    const p = await project("typescript", {
      "src/use.ts": `import axios from "axios";
export function main(): void { axios.get("/x"); }`,
    });
    const r = p.call("src.use", "get");
    expect(r.targetId).toBe("ext:axios");
    expect(r.external).toBe(true);
    expect(r.reason).toContain("axios is imported from axios");
  });

  it("records a runtime global receiver as external", async () => {
    const p = await project("typescript", {
      "src/use.ts": `export function main(): void { console.log("hi"); }`,
    });
    const r = p.call("src.use", "log");
    expect(r.targetId).toBe("ext:console");
    expect(r.reason).toContain("runtime global");
  });

  it("makes a phantom for a method that exists on no known type", async () => {
    const p = await project("typescript", {
      "src/a.ts": `export class Sub {
  run(): void { this.nothere(); }
}`,
    });
    const r = p.call("src.a", "nothere");
    expect(r.resolved).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.targetId).toContain("__unknown__");
    expect(r.reason).toContain("not found on");
  });

  it("makes a phantom for a bare call declared nowhere", async () => {
    const p = await project("typescript", {
      "src/a.ts": `export function caller(): void { ghost(); }`,
    });
    const r = p.call("src.a", "ghost");
    expect(r.resolved).toBe(false);
    expect(r.reason).toContain("not found in module src.a");
  });
});

describe("generic resolver — constructors", () => {
  it("resolves a constructor call to the type's default constructor", async () => {
    const p = await project("typescript", {
      "src/a.ts": `export class Service { work(): void {} }
export function main(): void { new Service(); }`,
    });
    const r = p.call("src.a", "Service");
    expect(r.callSite.isConstructorCall).toBe(true);
    expect(r.targetId).toBe("src.a.Service#<init>");
    expect(r.confidence).toBe(0.9);
    expect(r.reason).toContain("default constructor");
  });

  it("resolves a Python builtin type to ext:builtins", async () => {
    const p = await project("python", {
      "app/a.py": `def make():
    return dict()
`,
    });
    const r = p.call("app.a", "dict");
    expect(r.targetId).toBe("ext:builtins");
    expect(r.reason).toContain("Python builtin type");
  });

  it("resolves a Python builtin function to ext:builtins", async () => {
    const p = await project("python", {
      "app/a.py": `def shout():
    print("x")
`,
    });
    const r = p.call("app.a", "print");
    expect(r.targetId).toBe("ext:builtins");
    expect(r.reason).toContain("Python builtin");
  });

  it("dispatches super().__init__() to the parent constructor", async () => {
    const p = await project("python", {
      "app/a.py": `class Base:
    def __init__(self):
        pass

class Child(Base):
    def __init__(self):
        super().__init__()
`,
    });
    const r = p.call("app.a", "__init__");
    expect(r.targetId).toBe("app.a.Base#<init>");
    expect(r.resolved).toBe(true);
    expect(r.reason).toContain("super resolves to the parent type");
  });
});

describe("reflective target resolution", () => {
  it("resolves a project module reference", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "module",
      target: "src.svc",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("module:src.svc");
    expect(r.reason).toBe("module src.svc");
  });

  it("records an unknown module as an external package", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "module",
      target: "fastapi",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("ext:fastapi");
    expect(r.external).toBe("fastapi");
  });

  it("resolves a project type reference", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "type",
      target: "Service",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("src.svc.Service");
    expect(r.reason).toBe("type src.svc.Service");
  });

  it("attributes an imported type to its real package, not its symbol name", async () => {
    const p = await project("python", {
      "app/a.py": `from fastapi import Depends

def handler(dep=Depends()):
    pass
`,
    });
    const r = resolveReflectiveTarget(p.file("app.a"), p.index, {
      targetKind: "type",
      target: "Depends",
      enclosingTypeId: "app.a",
      enclosingMethodId: "app.a#handler",
    });
    expect(r.targetId).toBe("ext:fastapi");
    expect(r.external).toBe("fastapi");
  });

  it("marks an unresolvable type as a reflection placeholder", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "type",
      target: "Ghost",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("__reflect__:Ghost");
    expect(r.reason).toBe("type Ghost not found");
  });

  it("resolves a method lookup through a field receiver", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "method",
      target: "work",
      receiver: "this.svc",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("src.svc.Service#work");
    expect(r.reason).toContain("work on src.svc.Service");
  });

  it("attributes a method lookup on an external receiver to the package", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "method",
      target: "log",
      receiver: "console",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("ext:console");
    expect(r.external).toBe("console");
  });

  it("resolves a bare method lookup to a module-level function", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "method",
      target: "makeService",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("__reflect__:makeService");
  });

  it("falls back to a type of the same name when no method matches", async () => {
    const p = await tsProject();
    const r = resolveReflectiveTarget(p.file("src.app"), p.index, {
      targetKind: "method",
      target: "Service",
      enclosingTypeId: "src.app.Holder",
      enclosingMethodId: "src.app.Holder#run",
    });
    expect(r.targetId).toBe("src.svc.Service");
    expect(r.reason).toBe("type Service");
  });
});

describe("injection target resolution", () => {
  it("resolves a project type", async () => {
    const p = await tsProject();
    expect(resolveInjectionTarget(p.file("src.app"), p.index, "Service")).toEqual({
      targetId: "src.svc.Service",
    });
  });

  it("attributes an imported marker to the real package", async () => {
    const p = await project("python", {
      "app/a.py": `from fastapi import Depends

def handler(dep=Depends()):
    pass
`,
    });
    expect(resolveInjectionTarget(p.file("app.a"), p.index, "Depends")).toEqual({
      targetId: "ext:fastapi",
      external: "fastapi",
    });
  });

  it("treats an unimported simple name as an external package", async () => {
    const p = await tsProject();
    expect(resolveInjectionTarget(p.file("src.app"), p.index, "FastAPI")).toEqual({
      targetId: "ext:FastAPI",
      external: "FastAPI",
    });
  });

  it("declines an empty type", async () => {
    const p = await tsProject();
    expect(resolveInjectionTarget(p.file("src.app"), p.index, "")).toBeNull();
  });
});

describe("route handler resolution", () => {
  it("resolves a module-level handler", async () => {
    const p = await project("python", {
      "app/api.py": `def read_order():
    return None
`,
    });
    expect(resolveRouteHandler(p.file("app.api"), p.index, "read_order", "app.api")).toBe(
      "module:app.api#read_order"
    );
  });

  it("resolves a method declared on a type in the same file", async () => {
    const p = await project("typescript", {
      "src/api.ts": `export class Controller { read(): void {} }`,
    });
    expect(resolveRouteHandler(p.file("src.api"), p.index, "read", "src.api")).toBe(
      "src.api.Controller#read"
    );
  });

  it("resolves a handler imported from another module", async () => {
    const p = await project("typescript", {
      "src/svc.ts": `export function read(): void {}`,
      "src/api.ts": `import { read } from "./svc";
export const x = 1;`,
    });
    expect(resolveRouteHandler(p.file("src.api"), p.index, "read", "src.api")).toBe(
      "module:src.svc#read"
    );
  });

  it("returns null for a handler that exists nowhere", async () => {
    const p = await project("typescript", {
      "src/api.ts": `export const x = 1;`,
    });
    expect(resolveRouteHandler(p.file("src.api"), p.index, "ghost", "src.api")).toBeNull();
  });
});

describe("generic resolver — namespace and fallback branches", () => {
  it("resolves a call through an imported module namespace", async () => {
    const p = await project("typescript", {
      "src/svc.ts": `export function makeService(): void {}`,
      "src/use.ts": `import * as svc from "./svc";
export function main(): void { svc.makeService(); }`,
    });
    const r = p.call("src.use", "makeService");
    expect(r.targetId).toBe("module:src.svc#makeService");
    expect(r.reason).toContain("exported by module src.svc");
  });

  it("makes a phantom for a constructor of an undeclared type", async () => {
    const p = await project("python", {
      "app/a.py": `def make():
    return Foo()
`,
    });
    const r = p.call("app.a", "Foo");
    expect(r.callSite.isConstructorCall).toBe(true);
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe('type "Foo" not found in project');
  });

  it("treats a builtin method on a project type as external", async () => {
    const p = await project("python", {
      "app/a.py": `class Repo:
    def find(self):
        pass

def use():
    r = Repo()
    r.print(1)
`,
    });
    const r = p.call("app.a", "print");
    expect(r.targetId).toBe("ext:builtins");
    expect(r.reason).toContain("print is a Python builtin");
  });

  it("falls back to a token node when an injection names an unknown project symbol", async () => {
    const p = await tsProject();
    // `src.svc` is a known module, so the name is neither a resolvable type nor
    // an external package -- the graph still records the dependency.
    expect(resolveInjectionTarget(p.file("src.app"), p.index, "src.svc.Ghost")).toEqual({
      targetId: "__inject__:src.svc.Ghost",
    });
  });
});
