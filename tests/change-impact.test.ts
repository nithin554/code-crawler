import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { changeImpact, parseUnifiedDiff } from "../src/graph/changeImpact.js";
import { GraphStore } from "../src/graph/store.js";

const FIXTURE = path.join(__dirname, "fixtures", "java", "impact");
const SERVICE_FILE = "com/acme/impact/OrderService.java";
const CONTROLLER_FILE = "com/acme/impact/OrderController.java";
const SERVICE = "com.acme.impact.OrderService";
const REPOSITORY = "com.acme.impact.OrderRepository";
const CONTROLLER = "com.acme.impact.OrderController";
const FIND = `${SERVICE}#find`;

let store: GraphStore;

/** A one-file unified diff whose hunk covers `lines`, as git would print it. */
function diffOf(file: string, start: number, count: number): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},${count} +${start},${count} @@`,
    " context",
    "-removed",
    "+added",
  ].join("\n");
}

beforeAll(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  await crawlProject(store, FIXTURE, loadConfig().excludeDirs, {});
});

afterAll(() => {
  store.close();
});

describe("parseUnifiedDiff", () => {
  it("collects every hunk of every file on the new side", () => {
    const diff = [
      "diff --git a/a/One.java b/a/One.java",
      "--- a/a/One.java",
      "+++ b/a/One.java",
      "@@ -3,2 +3,5 @@",
      "@@ -20 +22,2 @@",
      "diff --git a/b/Two.py b/b/Two.py",
      "--- a/b/Two.py",
      "+++ b/b/Two.py",
      "@@ -1,4 +1,4 @@",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        file: "a/One.java",
        ranges: [
          { start: 3, end: 7 },
          { start: 22, end: 23 },
        ],
      },
      { file: "b/Two.py", ranges: [{ start: 1, end: 4 }] },
    ]);
  });

  it("anchors a deletion-only hunk where the deletion happened", () => {
    const diff = [
      "--- a/src/App.ts",
      "+++ b/src/App.ts",
      "@@ -40,3 +40,0 @@",
      "-a",
      "-b",
      "-c",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]?.ranges).toEqual([{ start: 40, end: 40 }]);
  });

  it("drops a deleted file and keeps a rename's new path", () => {
    const diff = [
      "--- a/gone/Old.java",
      "+++ /dev/null",
      "@@ -1,9 +0,0 @@",
      "--- a/moved/Before.java",
      "+++ b/moved/After.java",
      "@@ -5,2 +5,2 @@",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: "moved/After.java", ranges: [{ start: 5, end: 6 }] },
    ]);
  });

  it("strips prefixes, backslashes and CRLF, and ignores a file with no hunks", () => {
    const diff = [
      "--- a/com/acme/etc/Thing.java",
      "+++ b/com/acme/etc/Thing.java",
      "@@ -1 +1 @@",
      "--- a/quiet/Untouched.java",
      "+++ b/quiet/Untouched.java",
    ].join("\r\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: "com/acme/etc/Thing.java", ranges: [{ start: 1, end: 1 }] },
    ]);
    expect(
      parseUnifiedDiff(["--- a/x/Y.ts", "+++ b/x/Y.ts", "@@ -2,2 +2,2 @@"].join("\r\n"))[0]
    ).toEqual({ file: "x/Y.ts", ranges: [{ start: 2, end: 3 }] });
    expect(
      parseUnifiedDiff(["--- a/win\\Z.java", "+++ b/win\\Z.java", "@@ -2 +2 @@"].join("\n"))[0]
        ?.file
    ).toBe("win/Z.java");
  });

  it("returns nothing for empty or hunk-free input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("not a diff at all")).toEqual([]);
  });
});

describe("changeImpact diff mode", () => {
  it("maps a hunk onto the method it overlaps and not its enclosing class", () => {
    // OrderService#find occupies lines 16-19; the class spans 11-24.
    const report = changeImpact(store, { diff: diffOf(SERVICE_FILE, 16, 4) });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([FIND]);
    const entry = report.symbols[0];
    expect(entry?.matchedBy).toBe("diff");
    expect(entry?.diffRanges).toEqual([{ start: 16, end: 19 }]);
    expect(report.input).toEqual({ symbols: 0, files: [], hunks: 1 });
  });

  it("keeps the class when only a field or annotation line was touched", () => {
    // Line 13 is the injected repository field, outside every method body.
    const report = changeImpact(store, { diff: diffOf(SERVICE_FILE, 13, 1) });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([SERVICE]);
    expect(report.symbols[0]?.matchedBy).toBe("diff");
  });

  it("reports the touched methods of two files independently", () => {
    const diff = [diffOf(SERVICE_FILE, 16, 4), diffOf(CONTROLLER_FILE, 17, 4)].join("\n");
    const report = changeImpact(store, { diff });
    expect(report.symbols.map((s) => s.symbol.id).sort()).toEqual([`${CONTROLLER}#show`, FIND]);
    expect(report.input.hunks).toBe(2);
  });

  it("returns unmatched paths instead of dropping them silently", () => {
    const report = changeImpact(store, {
      diff: [diffOf(SERVICE_FILE, 16, 4), diffOf("com/acme/impact/Missing.java", 1, 2)].join("\n"),
    });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([FIND]);
    expect(report.unmatched.files).toEqual(["com/acme/impact/Missing.java"]);
  });

  it("returns an empty report for a diff that touches nothing indexed", () => {
    const report = changeImpact(store, { diff: diffOf("elsewhere/Nothing.java", 1, 2) });
    expect(report.symbols).toEqual([]);
    expect(report.totals.symbols).toBe(0);
    expect(report.unmatched.files).toEqual(["elsewhere/Nothing.java"]);
  });
});

describe("changeImpact wiring", () => {
  it("reports who injects the changed type and what it injects", () => {
    const report = changeImpact(store, { symbols: [SERVICE] });
    const entry = report.symbols[0];
    expect(entry?.matchedBy).toBe("symbol");
    const injectedBy = entry?.injectionPoints.filter((i) => i.role === "injectedBy") ?? [];
    const injects = entry?.injectionPoints.filter((i) => i.role === "injects") ?? [];
    expect(injectedBy.map((i) => i.symbol.id)).toEqual([CONTROLLER]);
    expect(injectedBy[0]?.injectedName).toBe("orderService");
    expect(injectedBy[0]?.framework).toBe("spring");
    expect(injects.map((i) => i.symbol.id)).toEqual([REPOSITORY]);
    expect(entry?.summary.injectionPoints).toBe(2);
  });

  it("reports the advice that intercepts a changed type's members", () => {
    const report = changeImpact(store, { symbols: [SERVICE] });
    const advice = report.symbols[0]?.advice ?? [];
    expect(advice.map((a) => [a.advice.id, a.advised.id])).toEqual([
      ["com.acme.impact.TimingAspect#time", FIND],
    ]);
    expect(advice[0]?.framework).toBeUndefined();
    expect(report.symbols[0]?.summary.advice).toBe(1);
  });

  it("reports the advice that intercepts a changed method", () => {
    const report = changeImpact(store, { symbols: [FIND] });
    expect(report.symbols[0]?.advice.map((a) => a.advice.id)).toEqual([
      "com.acme.impact.TimingAspect#time",
    ]);
  });

  it("carries the route, entry point and call chain that reach the change", () => {
    const report = changeImpact(store, { symbols: [SERVICE] });
    const entry = report.symbols[0];
    expect(entry?.callers.map((c) => c.caller.id)).toContain(`${CONTROLLER}#show`);
    expect(entry?.entryPoints.map((e) => e.symbol.id)).toContain(`${CONTROLLER}#show`);
    const route = entry?.routes.find((r) => r.path === "/orders/{id}");
    expect(route?.httpMethod).toBe("GET");
    expect(route?.source.id).toBe(CONTROLLER);
    expect(entry?.summary.risk).toBe("high");
    expect(entry?.eventFlows).toEqual([]);
  });

  it("finds no advice for a type nothing advises", () => {
    const report = changeImpact(store, { symbols: [REPOSITORY] });
    expect(report.symbols[0]?.advice).toEqual([]);
  });
});

describe("changeImpact ranking and limits", () => {
  it("ranks a route-reachable change above a leaf one", () => {
    const report = changeImpact(store, { symbols: [REPOSITORY, SERVICE] });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([SERVICE, REPOSITORY]);
    expect(report.symbols[0]!.score).toBeGreaterThan(report.symbols[1]!.score);
  });

  it("de-duplicates a symbol requested twice and via two routes", () => {
    const report = changeImpact(store, {
      symbols: [SERVICE, SERVICE],
      diff: diffOf(SERVICE_FILE, 13, 1),
    });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([SERVICE]);
    expect(report.totals.symbols).toBe(1);
  });

  it("truncates to max_symbols and says so", () => {
    const report = changeImpact(
      store,
      { symbols: [SERVICE, REPOSITORY, CONTROLLER] },
      { maxSymbols: 1 }
    );
    expect(report.symbols).toHaveLength(1);
    expect(report.truncated).toBe(true);
  });

  it("counts totals across the kept symbols without double counting", () => {
    const report = changeImpact(store, { symbols: [SERVICE, REPOSITORY] });
    expect(report.totals.injectionPoints).toBe(3);
    expect(report.totals.callers).toBeGreaterThanOrEqual(3);
  });
});

describe("changeImpact file and symbol modes", () => {
  it("resolves a repo-relative path against a crawl-root-relative file_path", () => {
    const report = changeImpact(store, { files: [SERVICE_FILE] });
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([SERVICE]);
    expect(report.symbols[0]?.matchedBy).toBe("file");
    expect(report.input.files).toEqual([SERVICE_FILE]);
  });

  it("expands a file to its top-level types but not to their methods", () => {
    const report = changeImpact(store, { files: [CONTROLLER_FILE] });
    const ids = report.symbols.map((s) => s.symbol.id);
    expect(ids).toContain(CONTROLLER);
    expect(ids).not.toContain(`${CONTROLLER}#show`);
  });

  it("suggests alternatives for a symbol that is not in the index", () => {
    const report = changeImpact(store, { symbols: ["com.acme.impact.OrderServce"] });
    expect(report.symbols).toEqual([]);
    expect(report.unmatched.symbols).toEqual(["com.acme.impact.OrderServce"]);
  });

  it("combines all three input modes", () => {
    const report = changeImpact(store, {
      symbols: [REPOSITORY],
      files: [CONTROLLER_FILE],
      diff: diffOf(SERVICE_FILE, 16, 4),
    });
    // The diff names the method, not its class. The repository ranks first
    // because it has the most callers; the controller has none of its own.
    expect(report.symbols.map((s) => s.symbol.id)).toEqual([REPOSITORY, FIND, CONTROLLER]);
    expect(report.input.hunks).toBe(1);
  });
});
