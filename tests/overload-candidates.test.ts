import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { getCallees, getCallers, tracePath } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

const FIXTURE = path.join(__dirname, "fixtures", "java", "overloads");
const FORMATTER = "com.acme.overloads.Formatter";
const INT_OVERLOAD = `${FORMATTER}#render`;
const STRING_OVERLOAD = `${FORMATTER}#render(String)`;
const REPORT_CTOR = "com.acme.overloads.Report#<init>";
const REPORT_STRING_CTOR = "com.acme.overloads.Report#<init>(String)";

let store: GraphStore;

interface CallEdge {
  alternatives?: string[];
  confidence?: number;
  resolved?: boolean;
}

/** Properties of the CALLS edge joining one caller to one target. */
function callEdge(source: string, target: string): CallEdge {
  const rows = store.raw<{ properties: string }>(
    "SELECT properties FROM edges WHERE source = ? AND target = ? AND kind = 'CALLS'",
    source,
    target
  );
  if (rows.length === 0) throw new Error(`no CALLS edge ${source} -> ${target}`);
  return JSON.parse(rows[0]?.properties ?? "{}") as CallEdge;
}

beforeAll(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  await crawlProject(store, FIXTURE, loadConfig().excludeDirs, {});
});

afterAll(() => {
  store.close();
});

describe("an overload the call site cannot distinguish", () => {
  it("names the rival overload instead of only guessing", () => {
    const edge = callEdge(`${FORMATTER}#ambiguous`, INT_OVERLOAD);
    expect(edge.alternatives).toEqual([STRING_OVERLOAD]);
  });

  it("caps confidence below the band used for a proven pick", () => {
    expect(callEdge(`${FORMATTER}#ambiguous`, INT_OVERLOAD).confidence).toBe(0.6);
    expect(callEdge(`${FORMATTER}#byInt`, INT_OVERLOAD).confidence).toBeGreaterThan(0.6);
  });

  it("records no alternatives when an argument type settles the choice", () => {
    expect(callEdge(`${FORMATTER}#byInt`, INT_OVERLOAD).alternatives).toBeUndefined();
    expect(callEdge(`${FORMATTER}#byString`, STRING_OVERLOAD).alternatives).toBeUndefined();
  });

  it("still resolves the call, so traversal is unaffected", () => {
    expect(callEdge(`${FORMATTER}#ambiguous`, INT_OVERLOAD).resolved).toBe(true);
  });

  it("never lists the chosen target among its own rivals", () => {
    const edge = callEdge(`${FORMATTER}#ambiguous`, INT_OVERLOAD);
    expect(edge.alternatives).not.toContain(INT_OVERLOAD);
  });
});

describe("an overloaded constructor", () => {
  it("reports the rival when the argument type is unknown", () => {
    const edge = callEdge("com.acme.overloads.ReportFactory#fromValue", REPORT_CTOR);
    expect(edge.alternatives).toEqual([REPORT_STRING_CTOR]);
    expect(edge.confidence).toBe(0.6);
  });

  it("stays quiet when a literal pins the argument type", () => {
    const edge = callEdge("com.acme.overloads.ReportFactory#fromSize", REPORT_CTOR);
    expect(edge.alternatives).toBeUndefined();
    expect(edge.confidence).toBe(1);
  });
});

describe("a call with no overload in play", () => {
  it("carries no alternatives field at all", () => {
    const edge = callEdge(
      "com.acme.overloads.ReportFactory#describe",
      "com.acme.overloads.Report#label"
    );
    expect(edge.alternatives).toBeUndefined();
  });
});

describe("ambiguous candidates reach the tools", () => {
  it("appears on get_callers rows", () => {
    const result = getCallers(store, INT_OVERLOAD, { transitive: false, limit: 50 });
    if (!result) throw new Error("no callers");
    const row = result.callers.find((c) => c.caller.id === `${FORMATTER}#ambiguous`);
    expect(row?.alternatives).toEqual([STRING_OVERLOAD]);
    expect(row?.confidence).toBe(0.6);
  });

  it("appears on get_callees rows", () => {
    const result = getCallees(store, `${FORMATTER}#ambiguous`, { transitive: false, limit: 50 });
    if (!result) throw new Error("no callees");
    const row = result.callees.find((c) => c.callee.id === INT_OVERLOAD);
    expect(row?.alternatives).toEqual([STRING_OVERLOAD]);
  });

  it("appears on trace_path edges", () => {
    const trace = tracePath(store, "com.acme.overloads.ReportFactory#fromValue", REPORT_CTOR, {
      maxDepth: 5,
    });
    const edge = trace?.[0]?.edges.find((e) => e.target === REPORT_CTOR);
    expect(edge?.alternatives).toEqual([REPORT_STRING_CTOR]);
  });

  it("keeps constructor ids intact in trace_path", () => {
    // The path accumulator used to join ids with '>', which truncated every
    // `Type#<init>` target and blanked the edge kind.
    const trace = tracePath(store, "com.acme.overloads.ReportFactory#fromValue", REPORT_CTOR, {
      maxDepth: 5,
    });
    expect(trace?.[0]?.path).toEqual(["com.acme.overloads.ReportFactory#fromValue", REPORT_CTOR]);
    const edge = trace?.[0]?.edges[0];
    expect(edge?.target).toBe(REPORT_CTOR);
    expect(edge?.kind).toBe("CALLS");
  });
});

describe("incremental crawl", () => {
  let temp: string;
  let incremental: GraphStore;

  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-overloads-"));
    fs.cpSync(FIXTURE, temp, { recursive: true });
    incremental = new GraphStore(":memory:", { maxDepth: 10 });
    incremental.clearAll();
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
  });

  afterAll(() => {
    incremental.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("records the rival on a call added to a changed file", async () => {
    const file = path.join(temp, "com", "acme", "overloads", "Formatter.java");
    const source = fs
      .readFileSync(file, "utf8")
      .replace(
        "  public String byString() {",
        "  public String added(Object value) {\n    return render(value);\n  }\n\n  public String byString() {"
      );
    fs.writeFileSync(file, source);

    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});

    const rows = incremental.raw<{ properties: string }>(
      "SELECT properties FROM edges WHERE source = ? AND kind = 'CALLS' ORDER BY target",
      `${FORMATTER}#added`
    );
    expect(rows.length).toBe(1);
    const edge = JSON.parse(rows[0]?.properties ?? "{}") as CallEdge;
    expect(edge.alternatives).toEqual([STRING_OVERLOAD]);
  });
});
