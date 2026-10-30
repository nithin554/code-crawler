import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";

const FIXTURES = path.join(__dirname, "fixtures", "java", "dynamic");

let store: GraphStore;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  server = createServer(store, loadConfig());
  client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  await callTool("crawl_project", { path: FIXTURES });
});

afterEach(async () => {
  await client.close();
  store.close();
});

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`tool ${name} returned no text`);
  return JSON.parse(text) as T;
}

describe("dynamic tracing tools", () => {
  it("trace_execution weaves advice and virtual dispatch", async () => {
    const r = await callTool<{
      root: { qualifiedName: string };
      steps: { symbol: { qualifiedName: string }; via?: string }[];
    }>("trace_execution", { symbol: "com.acme.Checkout#checkout" });

    expect(r.root.qualifiedName).toBe("com.acme.Checkout#checkout");
    const byName = new Map(r.steps.map((s) => [s.symbol.qualifiedName, s]));
    expect(byName.get("com.acme.AuditAspect#beforeCheckout")?.via).toBe("INTERCEPT");
    expect(byName.get("com.acme.Payment#pay")?.via).toBe("CALLS");
    expect(byName.get("com.acme.AuditAspect#auditPayment")?.via).toBe("INTERCEPT");
    expect(byName.get("com.acme.CardPayment#pay")?.via).toBe("DYNAMIC_DISPATCH");
    expect(byName.get("com.acme.UpiPayment#pay")?.via).toBe("DYNAMIC_DISPATCH");
  });

  it("trace_execution can omit advice", async () => {
    const r = await callTool<{ steps: { symbol: { qualifiedName: string }; via?: string }[] }>(
      "trace_execution",
      { symbol: "com.acme.Checkout#checkout", include_advice: false }
    );
    expect(r.steps.every((s) => s.via !== "INTERCEPT")).toBe(true);
  });

  it("find_implementations lists interface implementers", async () => {
    const r = await callTool<{
      implementationCount: number;
      implementations: { type: { qualifiedName: string }; via: string }[];
    }>("find_implementations", { symbol: "com.acme.Payment" });
    expect(r.implementationCount).toBe(2);
    expect(r.implementations.map((i) => i.type.qualifiedName)).toEqual([
      "com.acme.CardPayment",
      "com.acme.UpiPayment",
    ]);
    expect(r.implementations.every((i) => i.via === "IMPLEMENTS")).toBe(true);
  });

  it("find_aspects reports advice and advised methods", async () => {
    const r = await callTool<{
      aspectCount: number;
      aspects: {
        aspect: { qualifiedName: string };
        advice: {
          method: { name: string };
          adviceKind: string;
          advised: { qualifiedName: string }[];
        }[];
      }[];
    }>("find_aspects");

    expect(r.aspectCount).toBe(1);
    expect(r.aspects[0]!.aspect.qualifiedName).toBe("com.acme.AuditAspect");
    const around = r.aspects[0]!.advice.find((a) => a.method.name === "auditPayment")!;
    expect(around.adviceKind).toBe("around");
    expect(around.advised.map((a) => a.qualifiedName).sort()).toEqual([
      "com.acme.CardPayment#pay",
      "com.acme.Payment#pay",
      "com.acme.UpiPayment#pay",
    ]);
  });

  it("get_decorators lists type and member decorators", async () => {
    const r = await callTool<{
      decorators: { name: string; decorator: boolean; line?: number }[];
      members: {
        symbol: { qualifiedName: string };
        decorators: { name: string; arguments: string[] }[];
      }[];
    }>("get_decorators", { symbol: "com.acme.DecoratedService", include_members: true });

    expect(r.decorators.map((d) => d.name)).toEqual(["Service"]);
    expect(r.decorators[0]!.decorator).toBe(false);
    const describe = r.members.find(
      (m) => m.symbol.qualifiedName === "com.acme.DecoratedService#describe"
    )!;
    expect(describe.decorators.map((d) => d.name)).toEqual(["Cacheable", "Transactional"]);
    const transactional = describe.decorators.find((d) => d.name === "Transactional")!;
    expect(transactional.arguments).toEqual(["readOnly = true"]);
  });

  it("find_annotated finds decorated methods", async () => {
    const r = await callTool<{
      count: number;
      results: { symbol: { qualifiedName: string }; arguments: string[] }[];
    }>("find_annotated", { annotation: "Transactional" });
    expect(r.count).toBe(1);
    expect(r.results[0]!.symbol.qualifiedName).toBe("com.acme.DecoratedService#describe");
    expect(r.results[0]!.arguments).toEqual(["readOnly = true"]);
  });

  it("find_hotspots counts advice interceptions", async () => {
    const r = await callTool<{
      hotspots: { symbol: { qualifiedName: string }; adviceCount: number }[];
    }>("find_hotspots", { limit: 50 });
    const pay = r.hotspots.find((h) => h.symbol.qualifiedName === "com.acme.Payment#pay");
    expect(pay?.adviceCount).toBe(1);
  });

  it("find_dead_code returns a list and excludes advised methods", async () => {
    const r = await callTool<{ count: number; unused: { symbol: { qualifiedName: string } }[] }>(
      "find_dead_code",
      { limit: 100 }
    );
    expect(Array.isArray(r.unused)).toBe(true);
    expect(r.unused.map((x) => x.symbol.qualifiedName)).not.toContain("com.acme.Payment#pay");
  });

  it("get_callees reports edge kinds when dynamic tracing is enabled", async () => {
    const r = await callTool<{
      callees: { callee: { qualifiedName: string }; edgeKind: string }[];
    }>("get_callees", { symbol: "com.acme.Checkout#checkout", include_dynamic: true });
    const pay = r.callees.find((c) => c.callee.qualifiedName === "com.acme.Payment#pay");
    expect(pay?.edgeKind).toBe("CALLS");
    const impl = r.callees.find((c) => c.callee.qualifiedName === "com.acme.CardPayment#pay");
    expect(impl?.edgeKind).toBe("DYNAMIC_DISPATCH");
  });
});
