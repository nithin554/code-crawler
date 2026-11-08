import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  constructorModeIn,
  frameworkScope,
  injectableFrameworkIn,
} from "../src/parser/frameworks/index.js";
import { javaConfig } from "../src/parser/languages/java.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "spring", "com", "acme", "wiring");

async function parse(name: string) {
  const file = path.join(FIXTURES, name);
  return javaConfig.parseFile(fs.readFileSync(file, "utf8"), file);
}

/** Injections as `Class:field -> Type`, in declaration order. */
async function injectionsOf(name: string): Promise<string[]> {
  return (await injectionsDetailed(name)).map(
    (i) => `${i.ownerId.slice(i.ownerId.lastIndexOf(".") + 1)}:${i.name} -> ${i.type}`
  );
}

async function injectionsDetailed(name: string) {
  const pf = await parse(name);
  return pf.injections ?? [];
}

describe("Spring constructor injection", () => {
  it("derives the sole constructor of a bean without any annotation", async () => {
    expect(await injectionsOf("ConstructorInjectedController.java")).toEqual([
      "ConstructorInjectedController:greetings -> GreetingService",
      "ConstructorInjectedController:audit -> AuditService",
    ]);
  });

  it("refuses to choose between two unannotated constructors", async () => {
    expect(await injectionsOf("TwoConstructorBean.java")).toEqual([]);
  });

  it("follows @Autowired when several constructors compete", async () => {
    expect(await injectionsOf("AutowiredChoice.java")).toEqual([
      "AutowiredChoice:greetings -> GreetingService",
      "AutowiredChoice:audit -> AuditService",
    ]);
  });

  it("keeps field injection and attributes it to the type", async () => {
    expect(await injectionsOf("FieldInjectedService.java")).toEqual([
      "FieldInjectedService:greeting -> GreetingService",
    ]);
  });

  it("attributes every injection to the container that performs it", async () => {
    for (const file of ["ConstructorInjectedController.java", "FieldInjectedService.java"]) {
      const found = await injectionsDetailed(file);
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found.map((i) => i.framework))).toEqual(new Set(["spring"]));
    }
  });

  it("ignores constructor injection on a class no container manages", async () => {
    expect(await injectionsOf("PlainPojo.java")).toEqual([]);
  });
});

describe("Lombok-generated constructor injection", () => {
  it("derives @AllArgsConstructor fields, skipping static and initialised ones", async () => {
    expect(await injectionsOf("LombokController.java")).toEqual([
      "LombokController:greetings -> GreetingService",
      "LombokController:audit -> AuditService",
    ]);
  });

  it("derives @RequiredArgsConstructor fields and nothing else", async () => {
    expect(await injectionsOf("RequiredArgsBean.java")).toEqual([
      "RequiredArgsBean:greeting -> GreetingService",
      "RequiredArgsBean:required -> AuditService",
    ]);
  });

  it("does not double count a hand-written constructor beside Lombok", async () => {
    expect(await injectionsOf("LombokWithConstructor.java")).toEqual([]);
  });

  it("ignores Lombok on a class no container manages", async () => {
    expect(await injectionsOf("NonBeanLombok.java")).toEqual([]);
  });

  it("marks the derived parameters as constructor parameters", async () => {
    const found = await injectionsDetailed("LombokController.java");
    expect(found.map((i) => i.kind)).toEqual(["constructor-parameter", "constructor-parameter"]);
  });
});

describe("constructor-generating annotations", () => {
  it("maps each annotation to the fields it promotes", () => {
    const scope = frameworkScope();
    expect(constructorModeIn(scope, "AllArgsConstructor")).toBe("all");
    expect(constructorModeIn(scope, "RequiredArgsConstructor")).toBe("required");
    expect(constructorModeIn(scope, "NoArgsConstructor")).toBeUndefined();
    // A prototype key must not resolve through `Object.prototype`.
    expect(constructorModeIn(scope, "toString")).toBeUndefined();
  });

  it("names the container an annotation marks", () => {
    const scope = frameworkScope();
    expect(injectableFrameworkIn(scope, "RestController")).toBe("spring");
    expect(injectableFrameworkIn(scope, "Service")).toBe("spring");
    expect(injectableFrameworkIn(scope, "PlainPojo")).toBeUndefined();
    expect(injectableFrameworkIn(scope, "toString")).toBeUndefined();
  });
});
