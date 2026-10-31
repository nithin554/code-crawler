import { describe, expect, it } from "vitest";
import {
  adviceIn,
  aspectIn,
  entryPointIn,
  frameworkNamed,
  frameworkNames,
  frameworkScope,
  injectableIn,
  injectionIn,
  listFrameworks,
  paramMarkerIn,
} from "../src/parser/frameworks/index.js";
import type { ImportInfo } from "../src/parser/language.js";
import { listLanguageDescriptors } from "../src/parser/languages/index.js";

/**
 * Frameworks are data now: a file in `src/parser/frameworks/` declares its
 * annotations, and the parser asks the registry what they mean. These tests
 * hold that contract, so supporting a new framework is a data change rather
 * than an edit to every parser that can host it.
 */

function imported(fqn: string, module?: string): ImportInfo {
  return { fqn, simpleName: fqn.split(".").pop() ?? fqn, isStatic: true, module };
}

const ONLY = (name: string) => [name];

describe("framework registry", () => {
  it("registers every framework exactly once", () => {
    const names = frameworkNames();
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(new Set(names).size).toBe(names.length);
    expect(listFrameworks().map((module) => module.name)).toEqual(names);
  });

  it("exposes every registered module by name", () => {
    for (const name of frameworkNames()) {
      expect(frameworkNamed(name)?.name).toBe(name);
    }
    expect(frameworkNamed("no-such-framework")).toBeUndefined();
  });

  it("registers every framework a language descriptor declares", () => {
    for (const descriptor of listLanguageDescriptors()) {
      for (const framework of descriptor.frameworks ?? []) {
        expect(frameworkNamed(framework), `${descriptor.name} declares ${framework}`).toBeDefined();
      }
    }
  });

  it("declares only known entry-point kinds", () => {
    const kinds = new Set(["http", "messaging", "scheduler", "event", "test", "cli"]);
    for (const module of listFrameworks()) {
      for (const spec of Object.values(module.entryPoints ?? {})) {
        expect(kinds.has(spec.kind), `${module.name} entry point ${spec.kind}`).toBe(true);
      }
      for (const spec of Object.values(module.qualifiedPrefixes ?? {})) {
        expect(kinds.has(spec.kind), `${module.name} prefix ${spec.kind}`).toBe(true);
      }
    }
  });

  it("declares its markers without empty evidence entries", () => {
    for (const module of listFrameworks()) {
      for (const entry of module.evidence ?? []) {
        expect(entry.length, `${module.name} evidence`).toBeGreaterThan(0);
      }
      const markers =
        Object.keys(module.entryPoints ?? {}).length +
        Object.keys(module.qualifiedPrefixes ?? {}).length +
        Object.keys(module.injections ?? {}).length +
        (module.injectables ?? []).length +
        (module.aspects ?? []).length +
        Object.keys(module.advice ?? {}).length +
        Object.keys(module.paramMarkers ?? {}).length +
        (module.evidence ?? []).length;
      expect(markers, `${module.name} declares something`).toBeGreaterThan(0);
    }
  });
});

describe("framework scope resolution", () => {
  it("degrades instead of throwing on an unknown framework name", () => {
    const scope = frameworkScope([], ["spring", "no-such-framework"]);
    expect(scope.preferred.map((module) => module.name)).toEqual(["spring"]);
    expect(scope.all.length).toBe(frameworkNames().length);
    expect(entryPointIn(scope, "GetMapping")?.module.name).toBe("spring");
  });

  it("puts import evidence first", () => {
    const scope = frameworkScope([imported("org.aspectj.lang.annotation.Aspect")], ONLY("spring"));
    expect(scope.evidenced.map((module) => module.name)).toContain("aspectj");
    expect(aspectIn(scope, "Aspect")).toBe(true);
    expect(adviceIn(scope, "Around")?.kind).toBe("around");
  });

  it("falls back to the descriptor order when there is no evidence", () => {
    const java = frameworkScope([], ["spring", "aspectj"]);
    expect(injectionIn(java, "Inject")).toBe("jakarta");
    expect(injectionIn(java, "Autowired")).toBe("spring");
  });

  it("settles a shared annotation name by evidence and language case", () => {
    expect(injectionIn(frameworkScope([imported("jakarta.inject.Inject")]), "Inject")).toBe(
      "jakarta"
    );
    expect(injectionIn(frameworkScope([imported("Inject", "@nestjs/common")]), "Inject")).toBe(
      "nestjs"
    );
    expect(
      injectionIn(frameworkScope([imported("inject", "dependency_injector.wiring")]), "inject")
    ).toBe("dependency-injector");
  });

  it("matches Python decorators case-insensitively without stealing from Java", () => {
    const python = frameworkScope([], ["fastapi", "flask", "dependency-injector"], true);
    expect(injectionIn(python, "inject")).toBe("dependency-injector");
    expect(injectionIn(python, "autowired")).toBe("dependency-injector");
  });
});

describe("framework annotation meanings", () => {
  it("reports HTTP verbs for Spring and NestJS", () => {
    const spring = frameworkScope([imported("org.springframework.web.bind.annotation.GetMapping")]);
    expect(entryPointIn(spring, "GetMapping")).toMatchObject({
      module: { name: "spring" },
      spec: { kind: "http", httpMethod: "GET" },
    });
    const nestjs = frameworkScope([imported("Get", "@nestjs/common")]);
    expect(entryPointIn(nestjs, "Get")?.spec.httpMethod).toBe("GET");
  });

  it("reports messaging, scheduling, events and tests", () => {
    const java = frameworkScope([imported("org.springframework.kafka.annotation.KafkaListener")]);
    expect(entryPointIn(java, "KafkaListener")?.spec.kind).toBe("messaging");
    expect(entryPointIn(java, "Scheduled")?.spec.kind).toBe("scheduler");
    expect(entryPointIn(java, "EventListener")?.spec.kind).toBe("event");
    expect(
      entryPointIn(frameworkScope([imported("org.junit.jupiter.api.Test")]), "Test")?.spec.kind
    ).toBe("test");
  });

  it("treats a pytest marker prefix as a test", () => {
    const python = frameworkScope([imported("pytest")], ["pytest"], true);
    expect(entryPointIn(python, "mark.parametrize", "mark.parametrize")?.spec.kind).toBe("test");
    expect(entryPointIn(python, "fixture")?.spec.kind).toBe("test");
  });

  it("lets a parser veto an entry-point meaning", () => {
    const python = frameworkScope([imported("flask")], ["flask"], true);
    expect(entryPointIn(python, "get")?.spec.kind).toBe("http");
    expect(entryPointIn(python, "get", "get", (spec) => spec.kind !== "http")).toBeUndefined();
  });

  it("recognises injection and container markers", () => {
    const nestjs = frameworkScope([imported("Injectable", "@nestjs/common")]);
    expect(injectableIn(nestjs, "Injectable")).toBe(true);
    expect(injectableIn(nestjs, "Unknown")).toBe(false);
    expect(injectionIn(nestjs, "InjectRepository")).toBe("nestjs");
    expect(injectionIn(nestjs, "Body")).toBe("nestjs-param");
  });

  it("recognises raw parameter markers", () => {
    const python = frameworkScope([imported("fastapi")], ["fastapi", "dependency-injector"], true);
    expect(paramMarkerIn(python, "db: Session = Depends( get_db )")).toBe("fastapi");
    expect(paramMarkerIn(python, "svc: Service = Provide[Container.svc]")).toBeUndefined();
    expect(paramMarkerIn(python, "svc: Service = Inject(Service)")).toBe("dependency-injector");
  });
});
