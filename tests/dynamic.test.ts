import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { GraphStore } from "../src/graph/store.js";
import { crawlProject, type CrawlResult } from "../src/crawler.js";
import { initTreeSitter } from "../src/parser/treeSitter.js";
import { parseFile, type JavaParsedFile } from "../src/parser/languages/java.js";
import {
  isDecoratorAnnotation,
  matchExecution,
  matchPointcut,
  matchTypePattern,
} from "../src/resolver/dynamic.js";
import {
  deadCode,
  findAnnotated,
  findImplementations,
  getAspects,
  getDecorators,
  hotspots,
  traceExecution,
} from "../src/graph/queries.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "dynamic");

let store: GraphStore;
let crawl: CrawlResult;

async function parseFixture(file: string): Promise<JavaParsedFile> {
  const full = path.join(FIXTURES, "com", "acme", file);
  return parseFile(readFileSync(full, "utf8"), full);
}

beforeAll(async () => {
  await initTreeSitter();
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  crawl = await crawlProject(store, FIXTURES, []);
});

afterAll(() => {
  store.close();
});

describe("annotation and aspect extraction", () => {
  it("parses @Aspect, advice kinds and pointcut expressions", async () => {
    const parsed = await parseFixture("AuditAspect.java");
    const aspect = parsed.types[0]!;
    expect(aspect.isAspect).toBe(true);
    expect(aspect.annotations.map((a) => a.name)).toEqual(["Aspect"]);

    const byName = new Map(parsed.methods.map((m) => [m.name, m]));
    expect(byName.get("paymentCall")?.adviceKind).toBe("pointcut");
    expect(byName.get("auditPayment")?.adviceKind).toBe("around");
    expect(byName.get("auditPayment")?.pointcut).toBe("paymentCall()");
    expect(byName.get("beforeCheckout")?.pointcut).toBe(
      "execution(* com.acme.Checkout.checkout(..))"
    );
  });

  it("keeps annotations out of modifiers and preserves arguments", async () => {
    const parsed = await parseFixture("DecoratedService.java");
    const type = parsed.types[0]!;
    expect(type.annotations.map((a) => a.name)).toEqual(["Service"]);

    const describe = parsed.methods.find((m) => m.name === "describe")!;
    expect(describe.modifiers).toEqual(["public"]);
    expect(describe.annotations.map((a) => a.name)).toEqual(["Transactional", "Cacheable"]);
    const transactional = describe.annotations.find((a) => a.name === "Transactional")!;
    expect(transactional.arguments).toEqual(["readOnly = true"]);
    const cacheable = describe.annotations.find((a) => a.name === "Cacheable")!;
    expect(cacheable.arguments).toEqual(['"orders"']);
  });

  it("identifies framework decorator annotations", () => {
    expect(isDecoratorAnnotation("Transactional")).toBe(true);
    expect(isDecoratorAnnotation("Cacheable")).toBe(true);
    expect(isDecoratorAnnotation("Override")).toBe(false);
  });
});

describe("pointcut matching", () => {
  it("matches type patterns with wildcards", () => {
    expect(matchTypePattern("com.acme.*", "com.acme.CardPayment")).toBe(true);
    expect(matchTypePattern("com.acme.Card*", "com.acme.CardPayment")).toBe(true);
    expect(matchTypePattern("com.other.*", "com.acme.CardPayment")).toBe(false);
    expect(matchTypePattern("*", "com.acme.CardPayment")).toBe(true);
  });

  it("matches execution signatures including arity", async () => {
    const parsed = await parseFixture("CardPayment.java");
    const pay = parsed.methods.find((m) => m.name === "pay")!;
    expect(matchExecution("* com.acme.*.pay(..)", pay)).toBe(true);
    expect(matchExecution("void pay(double)", pay)).toBe(true);
    expect(matchExecution("* com.acme.*.pay()", pay)).toBe(false);
    expect(matchExecution("* com.other.*.pay(..)", pay)).toBe(false);
  });

  it("supports &&, ! and @annotation", async () => {
    const parsed = await parseFixture("CardPayment.java");
    const pay = parsed.methods.find((m) => m.name === "pay")!;
    const type = parsed.types[0]!;

    expect(
      matchPointcut("execution(* com.acme.*.pay(..))", pay, type.annotations, pay.annotations).matched
    ).toBe(true);
    expect(
      matchPointcut("execution(* com.acme.*.pay(..)) && !@annotation(Override)", pay, type.annotations, pay.annotations).matched
    ).toBe(false);
    expect(
      matchPointcut(
        "execution(* com.acme.*.pay(..)) && @annotation(Override)",
        pay,
        type.annotations,
        pay.annotations
      ).matched
    ).toBe(true);
    expect(
      matchPointcut("within(com.acme.CardPayment)", pay, type.annotations, pay.annotations).matched
    ).toBe(true);
  });
});

describe("dynamic graph enrichment", () => {
  it("reports dispatch, advice and decorator counts", () => {
    expect(crawl.filesParsed).toBe(6);
    expect(crawl.dynamicDispatchEdges).toBe(2);
    expect(crawl.adviceEdges).toBe(4);
    expect(crawl.aspects).toBe(1);
    expect(crawl.decorators).toBe(2);
  });

  it("finds implementers of an interface", () => {
    const result = findImplementations(store, "com.acme.Payment")!;
    expect(result.implementations.map((i) => i.type.qualifiedName)).toEqual([
      "com.acme.CardPayment",
      "com.acme.UpiPayment",
    ]);
    expect(result.implementations.every((i) => i.via === "IMPLEMENTS")).toBe(true);
  });

  it("links advice methods to the methods they intercept", () => {
    const aspects = getAspects(store);
    expect(aspects).toHaveLength(1);
    expect(aspects[0]!.aspect.qualifiedName).toBe("com.acme.AuditAspect");

    const advice = new Map(aspects[0]!.advice.map((a) => [a.method.name, a]));
    expect(advice.get("auditPayment")?.adviceKind).toBe("around");
    expect(advice.get("auditPayment")?.advised.map((r) => r.qualifiedName).sort()).toEqual([
      "com.acme.CardPayment#pay",
      "com.acme.Payment#pay",
      "com.acme.UpiPayment#pay",
    ]);
    expect(advice.get("beforeCheckout")?.advised.map((r) => r.qualifiedName)).toEqual([
      "com.acme.Checkout#checkout",
    ]);
  });

  it("weaves advice and virtual dispatch into an execution trace", () => {
    const trace = traceExecution(store, "com.acme.Checkout#checkout")!;
    const byName = new Map(trace.steps.map((s) => [s.symbol.qualifiedName, s]));

    expect(byName.get("com.acme.AuditAspect#beforeCheckout")?.via).toBe("INTERCEPT");
    expect(byName.get("com.acme.Payment#pay")?.via).toBe("CALLS");
    expect(byName.get("com.acme.AuditAspect#auditPayment")?.via).toBe("INTERCEPT");
    expect(byName.get("com.acme.CardPayment#pay")?.via).toBe("DYNAMIC_DISPATCH");
    expect(byName.get("com.acme.UpiPayment#pay")?.via).toBe("DYNAMIC_DISPATCH");
    expect(byName.has("com.acme.CardPayment#authorize")).toBe(true);
    expect(byName.has("com.acme.UpiPayment#settle")).toBe(true);

    // Each symbol is reported once, at its shallowest depth.
    const ids = trace.steps.map((s) => s.symbol.qualifiedName);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns annotations applied to a symbol and its members", () => {
    const type = getDecorators(store, "com.acme.DecoratedService", { includeMembers: true })!;
    expect(type.decorators.map((d) => d.name)).toEqual(["Service"]);
    expect(type.decorators[0]!.decorator).toBe(false);

    const method = type.members.find((m) => m.symbol.qualifiedName === "com.acme.DecoratedService#describe");
    expect(method?.decorators.map((d) => d.name)).toEqual(["Cacheable", "Transactional"]);
    expect(method?.decorators.find((d) => d.name === "Transactional")?.arguments).toEqual([
      "readOnly = true",
    ]);
  });

  it("finds symbols annotated with a given annotation", () => {
    const found = findAnnotated(store, "Transactional");
    expect(found.map((f) => f.symbol.qualifiedName)).toEqual(["com.acme.DecoratedService#describe"]);
    expect(found[0]!.arguments).toEqual(["readOnly = true"]);

    expect(findAnnotated(store, "@Aspect").map((f) => f.symbol.qualifiedName)).toEqual([
      "com.acme.AuditAspect",
    ]);
  });

  it("surfaces advice in hotspot ranking", () => {
    const hot = hotspots(store, { limit: 50 });
    const pay = hot.find((h) => h.symbol.qualifiedName === "com.acme.Payment#pay");
    expect(pay).toBeDefined();
    expect(pay!.adviceCount).toBe(1);
    expect(pay!.fanOut).toBe(2);
  });

  it("does not report advised or dispatched methods as dead code", () => {
    const dead = deadCode(store).map((d) => d.symbol.qualifiedName);
    expect(dead).not.toContain("com.acme.Payment#pay");
    expect(dead).not.toContain("com.acme.Checkout#checkout");
    expect(Array.isArray(dead)).toBe(true);
  });
});
