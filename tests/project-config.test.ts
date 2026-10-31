import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";
import {
  pythonModuleIdFromRelative,
  stripModuleRoots,
  tsModuleIdFromRelative,
} from "../src/parser/moduleId.js";
import { aliasSignature, matchAlias, readTsconfigAliases } from "../src/parser/tsPaths.js";

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

async function withProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-config-"));
  try {
    await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function crawl(dir: string) {
  return crawlProject(store, dir, loadConfig().excludeDirs, {});
}

describe("readTsconfigAliases", () => {
  it("returns no rules when the project has no tsconfig", () =>
    withProject(async (tmp) => {
      expect(readTsconfigAliases(tmp)).toEqual([]);
    }));

  it("reads a wildcard paths entry into prefix, suffix and target", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      });

      const rules = readTsconfigAliases(tmp);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        prefix: "@/",
        suffix: "",
        targets: ["src/*"],
        wildcard: true,
      });
    }));

  it("anchors relative targets to baseUrl", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: "src", paths: { "@app/*": ["app/*"] } },
      });

      expect(readTsconfigAliases(tmp)[0]?.targets).toEqual(["src/app/*"]);
    }));

  it("resolves targets to project-root-relative posix paths", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["packages/lib/src/*"] } },
      });

      expect(readTsconfigAliases(tmp)[0]?.targets).toEqual(["packages/lib/src/*"]);
    }));

  it("inherits paths from an extended config", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.base.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@base/*": ["lib/*"] } },
      });
      writeJson(path.join(tmp, "tsconfig.json"), { extends: "./tsconfig.base.json" });

      const rules = readTsconfigAliases(tmp);
      expect(rules.map((r) => r.prefix)).toEqual(["@base/"]);
      expect(rules[0]?.targets).toEqual(["lib/*"]);
    }));

  it("lets the extending config replace inherited paths wholesale", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.base.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@base/*": ["lib/*"] } },
      });
      writeJson(path.join(tmp, "tsconfig.json"), {
        extends: "./tsconfig.base.json",
        compilerOptions: { paths: { "@app/*": ["src/*"] } },
      });

      expect(readTsconfigAliases(tmp).map((r) => r.prefix)).toEqual(["@app/"]);
    }));

  it("orders rules longest prefix first", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@/app/*": ["src/app/*"] } },
      });

      expect(readTsconfigAliases(tmp).map((r) => r.prefix)).toEqual(["@/app/", "@/"]);
    }));

  it("degrades to no aliases when the tsconfig is not strict JSON", () =>
    withProject(async (tmp) => {
      write(
        path.join(tmp, "tsconfig.json"),
        '{\n  // comments are JSON5\n  "compilerOptions": {}\n}\n'
      );

      expect(readTsconfigAliases(tmp)).toEqual([]);
    }));

  it("falls back to jsconfig.json", () =>
    withProject(async (tmp) => {
      writeJson(path.join(tmp, "jsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
      });

      expect(readTsconfigAliases(tmp).map((r) => r.prefix)).toEqual(["~/"]);
    }));
});

describe("matchAlias", () => {
  it("joins the wildcard tail onto each target", () => {
    const matched = matchAlias(
      [{ prefix: "@app/", suffix: "", targets: ["src/*"], wildcard: true }],
      "@app/orders/service"
    );
    expect(matched).toEqual(["src/orders/service"]);
  });

  it("returns every declared target, in order", () => {
    const matched = matchAlias(
      [{ prefix: "@app/", suffix: "", targets: ["src/*", "generated/*"], wildcard: true }],
      "@app/x"
    );
    expect(matched).toEqual(["src/x", "generated/x"]);
  });

  it("matches a wildcard-free pattern only exactly", () => {
    const exact = [{ prefix: "lodash", suffix: "", targets: ["vendor/lodash"], wildcard: false }];
    expect(matchAlias(exact, "lodash")).toEqual(["vendor/lodash"]);
    // `lodash/debounce` is a different module and must stay external.
    expect(matchAlias(exact, "lodash/debounce")).toBeNull();
  });

  it("honours a suffix after the wildcard", () => {
    const rules = [{ prefix: "@app/", suffix: "/index", targets: ["src/*"], wildcard: true }];
    expect(matchAlias(rules, "@app/orders/index")).toEqual(["src/orders"]);
    expect(matchAlias(rules, "@app/orders")).toBeNull();
  });

  it("prefers the longest matching prefix", () => {
    const rules = [
      { prefix: "@/app/", suffix: "", targets: ["src/app/*"], wildcard: true },
      { prefix: "@/", suffix: "", targets: ["src/*"], wildcard: true },
    ];
    expect(matchAlias(rules, "@/app/x")).toEqual(["src/app/x"]);
  });

  it("ignores relative and absolute specifiers", () => {
    const rules = [{ prefix: "@", suffix: "", targets: ["src/*"], wildcard: true }];
    expect(matchAlias(rules, "./local")).toBeNull();
    expect(matchAlias(rules, "/abs/path")).toBeNull();
  });
});

describe("aliasSignature", () => {
  it("is stable across rule order but changes with the rules", () => {
    const a = { prefix: "@/*", suffix: "", targets: ["src/*"], wildcard: true };
    const b = { prefix: "~/*", suffix: "", targets: ["lib/*"], wildcard: true };

    expect(aliasSignature([a, b])).toBe(aliasSignature([b, a]));
    expect(aliasSignature([a, b])).not.toBe(aliasSignature([{ ...a, targets: ["app/*"] }]));
  });
});

describe("module roots", () => {
  it("strips a configured root", () => {
    expect(stripModuleRoots("src/orders/service.ts", ["src"])).toBe("orders/service.ts");
  });

  it("strips the longest configured root", () => {
    expect(stripModuleRoots("services/api/src/x.ts", ["src", "services/api"])).toBe("src/x.ts");
  });

  it("matches whole path segments only", () => {
    expect(stripModuleRoots("srcfoo/x.ts", ["src"])).toBe("srcfoo/x.ts");
  });

  it("leaves paths untouched without roots", () => {
    expect(stripModuleRoots("src/x.ts")).toBe("src/x.ts");
    expect(stripModuleRoots("src/x.ts", [])).toBe("src/x.ts");
  });

  it("produces shortened TypeScript and Python ids", () => {
    expect(tsModuleIdFromRelative("src/orders/service.ts", ["src"])).toBe("orders.service");
    expect(tsModuleIdFromRelative("src/orders/index.ts", ["src"])).toBe("orders");
    expect(pythonModuleIdFromRelative("src/app/__init__.py", ["src"])).toBe("app");
  });

  it("keeps full ids when no root applies", () => {
    expect(tsModuleIdFromRelative("src/orders/service.ts")).toBe("src.orders.service");
    expect(pythonModuleIdFromRelative("app/api/views.py")).toBe("app.api.views");
  });
});

describe("module roots and aliases in a crawl", () => {
  const SERVICE = "export function placeOrder(): number {\n  return 1;\n}\n";
  const APP = [
    'import { placeOrder } from "@/orders/service";',
    "",
    "export function run(): number {",
    "  return placeOrder();",
    "}",
    "",
  ].join("\n");

  it("puts module ids under the configured root", () =>
    withProject(async (tmp) => {
      write(path.join(tmp, "src", "orders", "service.ts"), SERVICE);
      write(path.join(tmp, "src", "app.ts"), APP);
      writeJson(path.join(tmp, ".crawlerrc"), { moduleRoots: ["src"] });

      await crawl(tmp);

      expect(store.getNode("module:orders.service")).not.toBeNull();
      expect(store.getNode("module:src.orders.service")).toBeNull();
      expect(store.getNode("module:app")).not.toBeNull();
    }));

  it("keeps the full path in module ids without a root", () =>
    withProject(async (tmp) => {
      write(path.join(tmp, "src", "orders", "service.ts"), SERVICE);
      write(path.join(tmp, "src", "app.ts"), APP);

      await crawl(tmp);

      expect(store.getNode("module:src.orders.service")).not.toBeNull();
      expect(store.getNode("module:orders.service")).toBeNull();
    }));

  it("resolves a tsconfig path alias to the real module", () =>
    withProject(async (tmp) => {
      write(path.join(tmp, "src", "orders", "service.ts"), SERVICE);
      write(
        path.join(tmp, "src", "app.ts"),
        'import { placeOrder } from "@app/orders/service";\n\nexport function run(): number {\n  return placeOrder();\n}\n'
      );
      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
      });

      await crawl(tmp);

      const target = store.raw(
        "SELECT target FROM edges WHERE kind = 'CALLS' AND target LIKE '%placeOrder%'"
      ) as { target: string }[];
      expect(target.map((r) => r.target)).toContain("module:src.orders.service#placeOrder");
    }));

  it("re-parses cached files when module roots change", () =>
    withProject(async (tmp) => {
      write(path.join(tmp, "src", "orders", "service.ts"), SERVICE);
      write(path.join(tmp, "src", "app.ts"), APP);

      const first = await crawl(tmp);
      expect(first.filesAdded).toBe(2);

      const second = await crawl(tmp);
      expect(second.filesUpdated).toBe(0);
      expect(second.filesUnchanged).toBe(2);

      writeJson(path.join(tmp, ".crawlerrc"), { moduleRoots: ["src"] });
      const third = await crawl(tmp);

      // Ids are baked into the cached summaries, so a config change must re-parse.
      expect(third.filesUpdated).toBe(2);
      expect(third.filesUnchanged).toBe(0);
      expect(store.getNode("module:orders.service")).not.toBeNull();
      expect(store.getNode("module:src.orders.service")).toBeNull();
    }));

  it("re-parses cached files when tsconfig aliases change", () =>
    withProject(async (tmp) => {
      write(path.join(tmp, "src", "orders", "service.ts"), SERVICE);
      write(path.join(tmp, "src", "app.ts"), APP);
      writeJson(path.join(tmp, "tsconfig.json"), { compilerOptions: { baseUrl: "." } });

      await crawl(tmp);
      const before = await crawl(tmp);
      expect(before.filesUpdated).toBe(0);

      writeJson(path.join(tmp, "tsconfig.json"), {
        compilerOptions: { baseUrl: ".", paths: { "@/orders/*": ["src/orders/*"] } },
      });
      const after = await crawl(tmp);

      expect(after.filesUpdated).toBe(2);
    }));
});
