import { describe, expect, it } from "vitest";
import type { MethodInfo } from "../src/parser/language.js";
import { javaConfig } from "../src/parser/languages/java.js";
import { pythonConfig } from "../src/parser/languages/python.js";
import { typescriptConfig } from "../src/parser/languages/typescript.js";
import { inferArgumentType, pickOverload } from "../src/resolver/common.js";
import { resolveJavaFile } from "../src/resolver/javaResolver.js";
import { buildTypeIndex } from "../src/resolver/types.js";

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

describe("argument type hints", () => {
  it("infers a type from literals and constructor calls", () => {
    expect(inferArgumentType('"x"')).toBe("String");
    expect(inferArgumentType("'c'")).toBe("char");
    expect(inferArgumentType("42")).toBe("int");
    expect(inferArgumentType("42L")).toBe("long");
    expect(inferArgumentType("4.5")).toBe("double");
    expect(inferArgumentType("1e3")).toBe("double");
    expect(inferArgumentType("true")).toBe("boolean");
    expect(inferArgumentType("new com.acme.Order(1)")).toBe("Order");
    expect(inferArgumentType("(Order) value")).toBe("Order");
  });

  it("declines to guess when the text carries no type signal", () => {
    for (const text of ["count", "this.value", "fetch()", "null", "count + 1", ""]) {
      expect(inferArgumentType(text), text).toBeNull();
    }
  });
});

describe("type-aware overload selection", () => {
  const asInt = { ...method("f", ["int"]), id: "T#f(int)" };
  const asLong = { ...method("f", ["long"]), id: "T#f(long)" };
  const asString = { ...method("f", ["String"]), id: "T#f(String)" };

  it("prefers the overload whose parameter type matches the argument", () => {
    expect(pickOverload([asString, asInt], 1, ["int"])?.id).toBe("T#f(int)");
    expect(pickOverload([asInt, asString], 1, ["String"])?.id).toBe("T#f(String)");
  });

  it("prefers an exact match over a widening conversion", () => {
    expect(pickOverload([asLong, asInt], 1, ["int"])?.id).toBe("T#f(int)");
    // `int` still converts to `long`, so the only candidate stays reachable.
    expect(pickOverload([asLong], 1, ["int"])?.id).toBe("T#f(long)");
  });

  it("falls back to the first declaration when no type is known", () => {
    expect(pickOverload([asString, asInt], 1, ["count"])?.id).toBe("T#f(String)");
    expect(pickOverload([asInt, asString], 1)?.id).toBe("T#f(int)");
  });

  it("keeps arity ahead of type hints", () => {
    const twoArgs = { ...method("f", ["String", "String"]), id: "T#f(String,String)" };
    // One known argument must not pull the two-argument declaration in.
    expect(pickOverload([twoArgs, asInt], 1, ["String"])?.id).toBe("T#f(int)");
  });
});

describe("overloaded declarations keep distinct ids", () => {
  it("appends parameter types after the first declaration", async () => {
    const parsed = await javaConfig.parseFile(
      `package com.acme;
       public class Fmt {
         public String join(int value) { return ""; }
         public String join(String text) { return text; }
         public String join(String a, String b) { return a; }
         public Fmt() {}
         public Fmt(int n) {}
       }`,
      "/tmp/Fmt.java"
    );
    expect(parsed.methods.map((m) => m.id)).toEqual([
      "com.acme.Fmt#join",
      "com.acme.Fmt#join(String)",
      "com.acme.Fmt#join(String,String)",
      "com.acme.Fmt#<init>",
      "com.acme.Fmt#<init>(int)",
    ]);
  });

  it("marks the varargs parameter in the overload signature", async () => {
    const parsed = await javaConfig.parseFile(
      `class L {
         void log(String fmt) {}
         void log(String fmt, Object... args) {}
       }`,
      "/tmp/L.java"
    );
    expect(parsed.methods.map((m) => m.id)).toEqual(["L#log", "L#log(String,Object...)"]);
  });

  it("leaves a method with a single declaration on the bare id", async () => {
    const parsed = await javaConfig.parseFile(
      `class L {
         void once(int a) {}
       }`,
      "/tmp/Once.java"
    );
    expect(parsed.methods.map((m) => m.id)).toEqual(["L#once"]);
  });
});

describe("Java overload resolution", () => {
  async function resolve(sources: string[]) {
    const parsed = await Promise.all(
      sources.map((source, index) => javaConfig.parseFile(source, `/tmp/com/acme/Y${index}.java`))
    );
    const index = buildTypeIndex(parsed);
    return parsed.flatMap((parsedFile) => resolveJavaFile(parsedFile, index));
  }

  it("binds a call to the overload matching the argument type", async () => {
    const resolved = await resolve([
      `package com.acme;
       public class Fmt {
         public String join(int value) { return ""; }
         public String join(String text) { return text; }
       }`,
      `package com.acme;
       public class Use {
         void run(Fmt fmt) {
           fmt.join(3);
           fmt.join("x");
         }
       }`,
    ]);
    const targets = resolved.filter((r) => r.resolved).map((r) => r.targetId);
    expect(targets.sort()).toEqual(["com.acme.Fmt#join", "com.acme.Fmt#join(String)"]);
  });

  it("reaches a variadic overload for extra arguments", async () => {
    // The Java resolver used to keep its own arity-only overload picker, so a
    // call with more arguments than the first declaration accepted fell back to
    // that first declaration instead of the `Object...` one.
    const resolved = await resolve([
      `package com.acme;
       public class L {
         public void log(String fmt) {}
         public void log(String fmt, Object... args) {}
       }`,
      `package com.acme;
       public class V {
         void run(L l) {
           l.log("a", 1, 2);
         }
       }`,
    ]);
    const targets = resolved.filter((r) => r.resolved).map((r) => r.targetId);
    expect(targets).toEqual(["com.acme.L#log(String,Object...)"]);
  });

  it("keeps enclosing-method locals attached to a later overload", async () => {
    const resolved = await resolve([
      `package com.acme;
       public class Repo {
         public void save(String text) {}
         public void save(String text, int retries) {}
       }`,
      `package com.acme;
       public class Svc {
         void run(Repo repo) {
           repo.save("a", 1);
         }
         void run(Repo repo, int retries) {
           Repo other = repo;
           other.save("b", retries);
         }
       }`,
    ]);
    const second = resolved.filter(
      (r) => r.resolved && r.targetId.startsWith("com.acme.Repo#save")
    );
    expect(second).toHaveLength(2);
    for (const call of second) {
      expect(call.targetId).toBe("com.acme.Repo#save(String,int)");
    }
  });
});
