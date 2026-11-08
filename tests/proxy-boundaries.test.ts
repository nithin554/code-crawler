import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { getCallers } from "../src/graph/queries.js";
import type { NodeProperties } from "../src/graph/schema.js";
import { GraphStore } from "../src/graph/store.js";

const FIXTURE = path.join(__dirname, "fixtures", "java", "proxies");
const ORDER = "com.acme.proxies.OrderService";
const REPORT = "com.acme.proxies.ReportService";

let store: GraphStore;

function props(id: string): NodeProperties {
  const node = store.getNode(id);
  if (!node) throw new Error(`no node ${id}`);
  return node.properties;
}

/** Caller rows keyed by caller id, for readable assertions. */
function callers(symbol: string, transitive = true) {
  const result = getCallers(store, symbol, { transitive, limit: 200 });
  if (!result) throw new Error(`no callers for ${symbol}`);
  return result.callers;
}

beforeAll(async () => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
  await crawlProject(store, FIXTURE, loadConfig().excludeDirs, {});
});

afterAll(() => {
  store.close();
});

describe("proxy annotations are recorded where they are declared", () => {
  it("puts a class-level annotation on the type", () => {
    expect(props(ORDER).proxies).toEqual(["transactional"]);
  });

  it("inherits a class-level annotation on a public method", () => {
    expect(props(`${ORDER}#place`).proxies).toEqual(["transactional"]);
    expect(props(`${ORDER}#place`).proxyBlocked).toBeUndefined();
  });

  it("keeps a method-level annotation", () => {
    expect(props(`${REPORT}#build`).proxies).toEqual(["cacheable"]);
    expect(props(`${REPORT}#recalculate`).proxies).toEqual(["transactional"]);
  });

  it("records nothing on a method with no proxy annotation", () => {
    expect(props(`${REPORT}#untouched`).proxies).toBeUndefined();
    expect(props(`${REPORT}#untouched`).proxyBlocked).toBeUndefined();
  });
});

describe("annotations the container cannot honour", () => {
  it("marks a private method as unproxied", () => {
    expect(props(`${ORDER}#audit`).proxies).toEqual(["async"]);
    expect(props(`${ORDER}#audit`).proxyBlocked).toBe("private");
  });

  it("marks a static method as unproxied", () => {
    expect(props(`${ORDER}#reset`).proxies).toEqual(["transactional"]);
    expect(props(`${ORDER}#reset`).proxyBlocked).toBe("static");
  });

  it("marks a final method as unproxied", () => {
    expect(props(`${ORDER}#seal`).proxies).toEqual(["transactional"]);
    expect(props(`${ORDER}#seal`).proxyBlocked).toBe("final");
  });

  it("marks every method of a final class as unproxied", () => {
    const run = props("com.acme.proxies.SealedService#run");
    expect(run.proxies).toEqual(["transactional"]);
    expect(run.proxyBlocked).toBe("final-type");
  });
});

describe("annotations that are not proxies", () => {
  it("does not treat a scheduler or event annotation as a proxy", () => {
    expect(props("com.acme.proxies.NotAService#tick").proxies).toBeUndefined();
    expect(props("com.acme.proxies.NotAService#on").proxies).toBeUndefined();
    expect(props("com.acme.proxies.NotAService#plain").proxies).toBeUndefined();
  });
});

describe("callers report whether the call crosses the proxy", () => {
  it("reports a cross-bean call as proxied", () => {
    const row = callers(`${ORDER}#place`).find((c) => c.caller.id === `${REPORT}#publish`);
    expect(row?.proxy).toEqual(["transactional"]);
    expect(row?.proxyBlocked).toBeUndefined();
    expect(row?.inert).toBeUndefined();
  });

  it("flags a self-invocation as bypassing the proxy", () => {
    const row = callers(`${ORDER}#place`).find((c) => c.caller.id === `${ORDER}#retry`);
    expect(row?.proxy).toEqual(["transactional"]);
    expect(row?.inert).toBe(true);
  });

  it("says nothing about proxies on a method that has none", () => {
    for (const row of callers(`${REPORT}#untouched`)) {
      expect(row.proxy).toBeUndefined();
      expect(row.proxyBlocked).toBeUndefined();
      expect(row.inert).toBeUndefined();
    }
  });

  it("keeps proxy facts off transitive rows", () => {
    const rows = callers(`${ORDER}#place`);
    const direct = rows.find((c) => c.caller.id === `${REPORT}#publish`);
    const indirect = rows.find((c) => c.caller.id === "com.acme.proxies.PublishJob#run");
    expect(direct?.depth).toBe(1);
    expect(direct?.proxy).toEqual(["transactional"]);
    expect(indirect?.depth).toBe(2);
    expect(indirect?.proxy).toBeUndefined();
    expect(indirect?.inert).toBeUndefined();
  });

  it("reports the static-only view without proxy facts", () => {
    const rows = callers(`${ORDER}#place`, false);
    const row = rows.find((c) => c.caller.id === `${REPORT}#publish`);
    expect(row?.proxy).toEqual(["transactional"]);
  });
});

describe("proxy facts survive an incremental crawl", () => {
  let temp: string;
  let incremental: GraphStore;

  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-proxies-"));
    fs.cpSync(FIXTURE, temp, { recursive: true });
    incremental = new GraphStore(":memory:", { maxDepth: 10 });
    incremental.clearAll();
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
  });

  afterAll(() => {
    incremental.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("picks up a newly added annotation on a changed file", async () => {
    const file = path.join(temp, "com", "acme", "proxies", "NotAService.java");
    const before = incremental.getNode("com.acme.proxies.NotAService#plain");
    expect(before?.properties.proxies).toBeUndefined();

    const source = fs
      .readFileSync(file, "utf8")
      .replace("    public void plain() {}", "    @Cacheable\n    public void plain() {}")
      .replace(
        "import org.springframework.scheduling.annotation.Scheduled;",
        "import org.springframework.cache.annotation.Cacheable;\nimport org.springframework.scheduling.annotation.Scheduled;"
      );
    fs.writeFileSync(file, source);

    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});

    const after = incremental.getNode("com.acme.proxies.NotAService#plain");
    expect(after?.properties.proxies).toEqual(["cacheable"]);
  });
});
