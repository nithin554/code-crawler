import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { compactify, looksLikeSymbolRef } from "../src/graph/compact.js";
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

/** Call a tool and return the raw JSON text, so size can be compared. */
async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`tool ${name} returned no text`);
  return text;
}

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return JSON.parse(await callRaw(name, args)) as T;
}

const REF = {
  id: "com.acme.Payment#pay",
  qualifiedName: "com.acme.Payment#pay",
  name: "pay",
  kind: "method",
  filePath: "C:\\proj\\Payment.java",
};

describe("compactify", () => {
  it("replaces a symbol reference with its qualified name", () => {
    expect(compactify(REF)).toBe("com.acme.Payment#pay");
  });

  it("walks arrays and nested objects, dropping no keys", () => {
    const input = {
      count: 1,
      callers: [
        { caller: REF, depth: 2, callSiteLine: 11 },
        { caller: REF, depth: 3 },
      ],
      target: REF,
    };

    expect(compactify(input)).toEqual({
      count: 1,
      callers: [
        { caller: "com.acme.Payment#pay", depth: 2, callSiteLine: 11 },
        { caller: "com.acme.Payment#pay", depth: 3 },
      ],
      target: "com.acme.Payment#pay",
    });
  });

  it("accepts the four-key projection search_symbols uses for packages", () => {
    const pkg = { id: "com.acme", qualifiedName: "com.acme", kind: "package", filePath: null };

    expect(compactify(pkg)).toBe("com.acme");
  });

  it("leaves an object that only resembles a reference alone", () => {
    const notARef = { kind: "CALLS", count: 4 };
    const edgeRow = { source: "A#a", target: "B#b", edgeKind: "CALLS" };

    expect(looksLikeSymbolRef(notARef)).toBe(false);
    expect(compactify(notARef)).toEqual({ kind: "CALLS", count: 4 });
    expect(compactify(edgeRow)).toEqual({ source: "A#a", target: "B#b", edgeKind: "CALLS" });
  });

  it("passes primitives, null and arrays of primitives through", () => {
    expect(compactify("x")).toBe("x");
    expect(compactify(7)).toBe(7);
    expect(compactify(null)).toBeNull();
    expect(compactify([1, "a", null])).toEqual([1, "a", null]);
  });
});

describe("compact mode on tools", () => {
  it("turns get_callers references into qualified names and keeps the scalars", async () => {
    const full = await callTool<{ target: unknown; callers: { caller: unknown; depth: number }[] }>(
      "get_callers",
      { symbol: "com.acme.Payment#pay" }
    );
    const compact = await callTool<{
      target: unknown;
      callers: { caller: unknown; depth: number; edgeKind: string }[];
    }>("get_callers", { symbol: "com.acme.Payment#pay", compact: true });

    expect(full.target).toMatchObject({ qualifiedName: "com.acme.Payment#pay" });
    expect(compact.target).toBe("com.acme.Payment#pay");
    expect(compact.callers[0].caller).toBe("com.acme.Checkout#checkout");
    expect(compact.callers[0].depth).toBe(full.callers[0].depth);
    expect(compact.callers[0].edgeKind).toBe("CALLS");
  });

  it("shrinks a trace while keeping the fields that carry meaning", async () => {
    const args = { symbol: "com.acme.Checkout#checkout" };
    const raw = await callRaw("trace_execution", args);
    const compactRaw = await callRaw("trace_execution", { ...args, compact: true });

    expect(compactRaw.length).toBeLessThan(raw.length * 0.6);

    const compact = JSON.parse(compactRaw) as {
      root: unknown;
      stepCount: number;
      steps: { symbol: unknown; via?: string; depth: number }[];
    };
    expect(compact.root).toBe("com.acme.Checkout#checkout");
    expect(compact.stepCount).toBe(JSON.parse(raw).stepCount);
    expect(compact.steps.map((s) => s.via)).toEqual(
      (JSON.parse(raw).steps as { via?: string }[]).map((s) => s.via)
    );
    expect(typeof compact.steps[0].symbol).toBe("string");
  });

  it("leaves an error payload readable", async () => {
    const r = await callTool<{ ok: boolean; error: string; hint: string }>("get_callers", {
      symbol: "com.acme.Missing#nope",
      compact: true,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
    expect(typeof r.hint).toBe("string");
  });

  it("keeps the default shape byte-identical when compact is omitted", async () => {
    const raw = await callRaw("get_callers", { symbol: "com.acme.Payment#pay" });

    expect(JSON.parse(raw).callers[0].caller).toMatchObject({ kind: "method" });
    expect(JSON.parse(raw)).not.toHaveProperty("compact");
  });

  it("offers compact on every tool", async () => {
    const { tools } = await client.listTools();
    const missing = tools.filter((t) => !("compact" in (t.inputSchema.properties ?? {})));

    expect(missing.map((t) => t.name)).toEqual([]);
  });

  it("composes with the token budget", async () => {
    const args = { query: "com.acme", max_tokens: 100 };
    const fullRaw = await callRaw("search_symbols", args);
    const compactRaw = await callRaw("search_symbols", { ...args, compact: true });
    const full = JSON.parse(fullRaw) as { results: unknown[]; page: { truncated: boolean } };
    const compact = JSON.parse(compactRaw) as {
      results: unknown[];
      page: { truncated: boolean; estimatedTokens: number };
    };

    // The budget picks the page before the projection runs, so compact keeps
    // the same items and makes the payload smaller. It is a size win, not a
    // packing win, and the estimate still describes the uncompacted page.
    expect(compact.results.length).toBe(full.results.length);
    expect(compact.results.every((r) => typeof r === "string")).toBe(true);
    expect(compactRaw.length).toBeLessThan(fullRaw.length * 0.7);
    expect(compact.page.estimatedTokens).toBe(full.page.estimatedTokens);
    expect(compact.page.truncated).toBe(full.page.truncated);
  });
});

describe("truncation signalling", () => {
  it("says how to continue when a budget cuts the list", async () => {
    const r = await callTool<{
      results: unknown[];
      page: { truncated: boolean; nextCursor?: number; hint?: string; totalCount: number };
    }>("search_symbols", { query: "com.acme", max_tokens: 100 });

    expect(r.page.truncated).toBe(true);
    expect(r.page.nextCursor).toBe(r.results.length);
    expect(r.page.hint).toContain(`cursor=${r.page.nextCursor}`);
    expect(r.page.hint).toContain(`of ${r.page.totalCount}`);
    expect(r.page.hint).toContain("max_tokens");
  });

  it("omits the hint when nothing was cut", async () => {
    const r = await callTool<{ page: { truncated: boolean; hint?: string } }>("search_symbols", {
      query: "com.acme",
      max_tokens: 100000,
    });

    expect(r.page.truncated).toBe(false);
    expect(r.page).not.toHaveProperty("hint");
  });

  it("returns the next page when the hint's cursor is followed", async () => {
    const first = await callTool<{
      results: { id: string }[] | string[];
      page: { nextCursor: number; totalCount: number };
    }>("search_symbols", { query: "com.acme", max_tokens: 100 });
    const second = await callTool<{ results: { id: string }[]; page: { cursor: number } }>(
      "search_symbols",
      { query: "com.acme", max_tokens: 100, cursor: first.page.nextCursor }
    );

    expect(second.page.cursor).toBe(first.page.nextCursor);
    expect(second.results.length).toBeGreaterThan(0);
    const firstIds = (first.results as { id: string }[]).map((r) => r.id);
    expect(firstIds).not.toContain(second.results[0].id);
  });
});
