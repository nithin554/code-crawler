import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { javaConfig } from "../src/parser/languages/java.js";
import { buildTypeIndex, type ResolvedCall, type TypeIndex } from "../src/resolver/types.js";
import { resolveJavaFile } from "../src/resolver/javaResolver.js";
import type { ParsedFile } from "../src/parser/language.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "sample");

async function loadFixture(): Promise<{ parsed: ParsedFile[]; index: TypeIndex; resolved: ResolvedCall[] }> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java")) files.push(p);
    }
  };
  walk(FIXTURES);

  const parsed: ParsedFile[] = [];
  for (const f of files.sort()) {
    parsed.push(await javaConfig.parseFile(fs.readFileSync(f, "utf8"), f));
  }
  const index = buildTypeIndex(parsed);
  const resolved = parsed.flatMap((pf) => resolveJavaFile(pf, index));
  return { parsed, index, resolved };
}

describe("Java resolver", () => {
  it("resolves calls across the fixture project", async () => {
    const { resolved } = await loadFixture();
    const ok = resolved.filter((r) => r.resolved);
    const unresolved = resolved.filter((r) => !r.resolved);

    expect(ok.length).toBeGreaterThanOrEqual(14);
    expect(unresolved).toHaveLength(1); // System.out.println

    const targets = new Set(ok.map((r) => r.targetId));
    expect(targets.has("com.acme.OrderRepository#create")).toBe(true);
    expect(targets.has("com.acme.CustomerService#find")).toBe(true);
    expect(targets.has("com.acme.OrderService#notify")).toBe(true);
    expect(targets.has("com.acme.Tracking#dispatch")).toBe(true);
  });

  it("infers receiver types from locals and fields", async () => {
    const { resolved } = await loadFixture();

    const place = resolved.find((r) => r.targetId === "com.acme.OrderService#place");
    expect(place).toBeTruthy();
    expect(place?.reason).toMatch(/local orders: OrderService/);

    const create = resolved.find((r) => r.targetId === "com.acme.OrderRepository#create");
    expect(create?.reason).toMatch(/field repo: OrderRepository/);
  });

  it("creates phantom targets for external calls", async () => {
    const { resolved } = await loadFixture();
    const println = resolved.find((r) => r.targetId === "__unknown__:System.out.println");
    expect(println).toBeTruthy();
    expect(println?.resolved).toBe(false);
    expect(println?.confidence).toBe(0);
  });

  it("resolves default constructors for types without explicit ones", async () => {
    const { resolved } = await loadFixture();
    const customerService = resolved.find(
      (r) => r.targetId === "com.acme.CustomerService#<init>" && r.callSite.isConstructorCall
    );
    expect(customerService?.resolved).toBe(true);
  });
});
