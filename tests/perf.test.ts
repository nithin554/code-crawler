/**
 * Scale guard. Runs a ~100k-line generated project through the crawler and the
 * hot queries, then asserts on the numbers that regress catastrophically if the
 * incremental manifest or the FTS index stops working.
 *
 * It is opt-in because a realistic corpus takes a while to crawl:
 *
 *   CODECRAWLER_BENCH=1 npm test -- tests/perf.test.ts
 *   npm run bench                                   # same corpus, prints a report
 */
import { describe, expect, it } from "vitest";

import { formatReport, runBenchmark } from "../bench/run.js";

const enabled = process.env.CODECRAWLER_BENCH === "1";
const targetLines = Number.parseInt(process.env.CODECRAWLER_BENCH_LINES ?? "100000", 10);

describe.skipIf(!enabled)("scale benchmark", () => {
  it("keeps incremental re-crawls and query latency within budget", {
    timeout: 900_000,
  }, async () => {
    const result = await runBenchmark({ targetLines });
    console.log(`\n${formatReport(result)}\n`);

    // The corpus must actually be the size we asked for.
    expect(result.lines).toBeGreaterThan(targetLines * 0.9);

    // A no-op re-crawl must re-parse nothing: every file replayed from cache.
    expect(result.noop.filesAdded).toBe(0);
    expect(result.noop.filesUpdated).toBe(0);
    expect(result.noop.filesUnchanged).toBe(result.files);

    // Editing one file must re-parse exactly that file.
    expect(result.oneFileEdit.filesAdded).toBe(0);
    expect(result.oneFileEdit.filesUpdated).toBe(1);
    expect(result.oneFileEdit.filesUnchanged).toBe(result.files - 1);

    // Incremental crawls are the whole point of the manifest: they must be a
    // large fraction cheaper than the cold crawl, not merely a bit faster.
    // Measured on this corpus the no-op re-crawl is ~7% of the cold crawl, so
    // a 25% ceiling leaves headroom while still failing if the manifest stops
    // being consulted.
    expect(result.noop.durationMs).toBeLessThan(result.cold.durationMs * 0.25);
    expect(result.oneFileEdit.durationMs).toBeLessThan(result.cold.durationMs * 0.25);

    // Query latency budget. Losing an index shows up here as a 10-100x jump.
    for (const q of result.queries) {
      expect(q.p95, `${q.name} p95`).toBeLessThan(q.budgetMs);
    }
  });
});
