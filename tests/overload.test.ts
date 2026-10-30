import { describe, expect, it } from "vitest";
import type { MethodInfo } from "../src/parser/language.js";
import { javaConfig } from "../src/parser/languages/java.js";
import { pythonConfig } from "../src/parser/languages/python.js";
import { typescriptConfig } from "../src/parser/languages/typescript.js";
import { pickOverload } from "../src/resolver/common.js";

function method(name: string, params: string[], variadic = false): MethodInfo {
  return {
    id: `T#${name}`,
    typeId: "T",
    name,
    isConstructor: false,
    params: params.map((type, index) => ({ name: `p${index}`, type })),
    ...(variadic ? { variadic: true } : {}),
    startLine: 0,
    endLine: 0,
    returnType: "",
    modifiers: [],
    annotations: [],
  };
}

describe("pickOverload", () => {
  it("returns nothing for an empty candidate list", () => {
    expect(pickOverload([], 2)).toBeUndefined();
  });

  it("returns the only candidate regardless of arity", () => {
    const only = method("f", ["int"]);
    expect(pickOverload([only], 7)).toBe(only);
  });

  it("prefers a fixed-arity declaration that matches exactly", () => {
    const variadic = method("f", ["String"], true);
    const fixed = method("f", ["String", "String"]);
    expect(pickOverload([variadic, fixed], 2)).toBe(fixed);
  });

  it("does not treat a fixed-arity declaration as variadic", () => {
    // A shorter fixed declaration must not absorb extra arguments: only a
    // declaration actually ending in `...` may. Both orders must agree.
    const fixed = method("f", ["int", "int"]);
    const variadic = method("f", ["int"], true);
    expect(pickOverload([fixed, variadic], 3)).toBe(variadic);
    expect(pickOverload([variadic, fixed], 3)).toBe(variadic);
  });

  it("accepts extra arguments for a variadic declaration", () => {
    const variadic = method("f", ["int", "String"], true);
    const fixed = method("f", ["int", "String"]);
    expect(pickOverload([fixed, variadic], 5)).toBe(variadic);
  });

  it("honours the variadic fixed prefix", () => {
    // `f(int, String...)` needs at least one argument, so a one-argument
    // fixed declaration is the better match.
    const variadic = method("f", ["int", "String"], true);
    const fixed = method("f", ["int"]);
    expect(pickOverload([variadic, fixed], 1)).toBe(fixed);
  });
});

describe("variadic parameters are recorded per language", () => {
  it("collects Java `Type...` parameters and flags them", async () => {
    const parsed = await javaConfig.parseFile(
      `class Files {
         void log(String fmt, Object... args) {}
       }`,
      "/tmp/Varargs.java"
    );
    const log = parsed.methods.find((m) => m.name === "log");
    // Before the fix the spread parameter was dropped entirely, so `log`
    // looked like a one-argument method.
    expect(log?.params.map((p) => p.name)).toEqual(["fmt", "args"]);
    expect(log?.params.map((p) => p.type)).toEqual(["String", "Object"]);
    expect(log?.variadic).toBe(true);
  });

  it("flags a Java varargs constructor", async () => {
    const parsed = await javaConfig.parseFile(
      `class Files {
         Files(String... names) {}
       }`,
      "/tmp/VarargsCtor.java"
    );
    const ctor = parsed.methods.find((m) => m.isConstructor);
    expect(ctor?.params.map((p) => p.name)).toEqual(["names"]);
    expect(ctor?.variadic).toBe(true);
  });

  it("leaves a Java fixed-arity method unflagged", async () => {
    const parsed = await javaConfig.parseFile(
      `class Files {
         void log(String fmt, Object arg) {}
       }`,
      "/tmp/Fixed.java"
    );
    expect(parsed.methods.find((m) => m.name === "log")?.variadic).toBe(false);
  });

  it("flags Python `*args` and `**kwargs`", async () => {
    const parsed = await pythonConfig.parseFile(
      "def log(fmt, *args, **kwargs):\n    pass\n",
      "/tmp/variadic.py",
      { projectRoot: "/tmp" }
    );
    const log = parsed.methods.find((m) => m.name === "log");
    expect(log?.params.length).toBe(3);
    expect(log?.variadic).toBe(true);
  });

  it("flags a TypeScript rest parameter", async () => {
    const parsed = await typescriptConfig.parseFile(
      "function log(fmt: string, ...args: unknown[]) {}",
      "/tmp/variadic.ts",
      { projectRoot: "/tmp" }
    );
    const log = parsed.methods.find((m) => m.name === "log");
    expect(log?.params.length).toBe(2);
    expect(log?.variadic).toBe(true);
  });

  it("leaves a TypeScript fixed-arity function unflagged", async () => {
    const parsed = await typescriptConfig.parseFile(
      "function log(fmt: string, arg: unknown) {}",
      "/tmp/fixed.ts",
      { projectRoot: "/tmp" }
    );
    expect(parsed.methods.find((m) => m.name === "log")?.variadic).toBe(false);
  });
});
