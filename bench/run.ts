/**
 * Benchmark harness: cold crawl, incremental re-crawl and query latency on a
 * generated project of ~100k lines.
 *
 * Run with `npm run bench`. `tests/perf.test.ts` reuses `runBenchmark()` behind
 * an env flag so CI does not pay for it on every run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crawlProject } from "../src/crawler.js";
import {
  deadCode,
  findEntryPoints,
  getCallees,
  getCallers,
  getSubgraph,
  hotspots,
  searchSymbols,
} from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";
import { generateProject } from "./generate.js";

export interface BenchOptions {
  targetLines?: number;
  queryIterations?: number;
  workDir?: string;
  log?: (line: string) => void;
}

export interface QueryTiming {
  name: string;
  p50: number;
  p95: number;
  /** p95 budget in ms. Interactive lookups are tight; whole-project analytics are looser. */
  budgetMs: number;
}

export interface CrawlTiming {
  durationMs: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
}

export interface BenchResult {
  requestedLines: number;
  lines: number;
  files: number;
  generatedMethods: number;
  nodes: number;
  edges: number;
  dbBytes: number;
  cold: CrawlTiming;
  /** Second crawl with nothing touched. */
  noop: CrawlTiming;
  /** Third crawl after editing a single file. */
  oneFileEdit: CrawlTiming;
  unresolvedCalls: number;
  queries: QueryTiming[];
}

function timing(r: {
  durationMs: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
}): CrawlTiming {
  return {
    durationMs: r.durationMs,
    filesAdded: r.filesAdded,
    filesUpdated: r.filesUpdated,
    filesUnchanged: r.filesUnchanged,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function dbSize(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      // Missing WAL/SHM files are normal when the database is idle.
    }
  }
  return total;
}

export async function runBenchmark(options: BenchOptions = {}): Promise<BenchResult> {
  const targetLines = options.targetLines ?? 100_000;
  const iterations = Math.max(3, options.queryIterations ?? 20);
  const log = options.log ?? (() => {});
  const workDir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-bench-"));

  try {
    const projectRoot = path.join(workDir, "project");
    const generated = generateProject(projectRoot, { targetLines });
    log(
      `generated ${generated.files} files / ${generated.lines} lines / ` +
        `${generated.methods} methods in ${projectRoot}`
    );

    const dbPath = path.join(workDir, "index.db");
    const store = new GraphStore(dbPath);
    try {
      const cold = await crawlProject(store, projectRoot, ["node_modules", "dist"]);
      log(`cold crawl: ${cold.durationMs} ms (${cold.nodes} nodes, ${cold.edges} edges)`);

      const noop = await crawlProject(store, projectRoot, ["node_modules", "dist"]);
      log(`no-op re-crawl: ${noop.durationMs} ms (${noop.filesUnchanged} unchanged)`);

      // Simulate a developer editing a single file: content differs, so exactly
      // one file must be re-parsed while the rest are replayed from the cache.
      const editedFile = path.join(projectRoot, "src", "mod0.ts");
      fs.appendFileSync(editedFile, "\n// touched by the benchmark\n", "utf8");
      const incremental = await crawlProject(store, projectRoot, ["node_modules", "dist"]);
      const now = new Date();
      fs.utimesSync(editedFile, now, now);
      log(
        `one-file edit: ${incremental.durationMs} ms ` +
          `(${incremental.filesUpdated} updated, ${incremental.filesUnchanged} unchanged)`
      );

      const ids = store
        .raw<{ id: string }>(
          "SELECT id FROM nodes WHERE kind = 'method' AND file_path LIKE 'src/mod1_%' ORDER BY id LIMIT 50"
        )
        .map((r) => r.id);
      const sample = ids[Math.floor(ids.length / 2)] ?? "Svc1#run";

      // `budgetMs` is a p95 ceiling, not a target. Interactive symbol lookups
      // must feel instant; `hotspots`/`dead_code` aggregate every edge and node
      // in the project, so they are allowed an order of magnitude more. Both
      // bands are set well above measured times so the gate fails only on a
      // real regression (losing an index, or going back to correlated
      // subqueries), never on page-cache noise.
      const cases: { name: string; budgetMs: number; run: () => unknown }[] = [
        {
          name: "search_symbols (exact)",
          budgetMs: 50,
          run: () => searchSymbols(store, "handle7_3"),
        },
        { name: "search_symbols (prefix)", budgetMs: 50, run: () => searchSymbols(store, "svc42") },
        {
          name: "get_callers (depth 2)",
          budgetMs: 50,
          run: () => getCallers(store, sample, { maxDepth: 2, limit: 50 }),
        },
        {
          name: "get_callees (depth 2)",
          budgetMs: 50,
          run: () => getCallees(store, sample, { maxDepth: 2, limit: 50 }),
        },
        {
          name: "get_subgraph (radius 2)",
          budgetMs: 50,
          run: () => getSubgraph(store, sample, { radius: 2 }),
        },
        {
          name: "find_entry_points",
          budgetMs: 50,
          run: () => findEntryPoints(store, { limit: 50 }),
        },
        { name: "find_hotspots", budgetMs: 1000, run: () => hotspots(store, { limit: 50 }) },
        { name: "find_dead_code", budgetMs: 1000, run: () => deadCode(store, { limit: 50 }) },
      ];

      const queries: QueryTiming[] = [];
      for (const c of cases) {
        c.run(); // warm-up, excluded from the percentiles
        const samples: number[] = [];
        for (let i = 0; i < iterations; i++) {
          const t0 = performance.now();
          c.run();
          samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        queries.push({
          name: c.name,
          p50: percentile(samples, 50),
          p95: percentile(samples, 95),
          budgetMs: c.budgetMs,
        });
      }

      const result: BenchResult = {
        requestedLines: targetLines,
        lines: generated.lines,
        files: generated.files,
        generatedMethods: generated.methods,
        nodes: store.stats().nodes,
        edges: store.stats().edges,
        dbBytes: dbSize(dbPath),
        cold: timing(cold),
        noop: timing(noop),
        oneFileEdit: timing(incremental),
        unresolvedCalls: cold.unresolvedCalls,
        queries,
      };
      return result;
    } finally {
      store.close();
    }
  } finally {
    if (!options.workDir) {
      fs.rmSync(workDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
}

export function formatReport(result: BenchResult): string {
  const rows: string[] = [];
  rows.push(
    `code-crawler benchmark — ${result.lines.toLocaleString("en-US")} lines, ` +
      `${result.files} files, ${result.nodes.toLocaleString("en-US")} nodes, ` +
      `${result.edges.toLocaleString("en-US")} edges ` +
      `(${(result.dbBytes / 1024 / 1024).toFixed(1)} MB index)`
  );
  rows.push("");
  rows.push("| Phase | Duration | Added | Updated | Unchanged |");
  rows.push("| --- | --- | --- | --- | --- |");
  const phases: [string, CrawlTiming][] = [
    ["Cold crawl", result.cold],
    ["Re-crawl, nothing changed", result.noop],
    ["Re-crawl after a one-file edit", result.oneFileEdit],
  ];
  for (const [label, t] of phases) {
    rows.push(
      `| ${label} | ${(t.durationMs / 1000).toFixed(2)} s | ${t.filesAdded} | ` +
        `${t.filesUpdated} | ${t.filesUnchanged} |`
    );
  }
  rows.push("");
  rows.push("| Query | p50 | p95 | Budget (p95) |");
  rows.push("| --- | --- | --- | --- |");
  for (const q of result.queries) {
    rows.push(`| ${q.name} | ${q.p50.toFixed(2)} ms | ${q.p95.toFixed(2)} ms | ${q.budgetMs} ms |`);
  }
  return rows.join("\n");
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const linesArg = process.argv.find((a) => a.startsWith("--lines="));
  const requested = linesArg?.split("=")[1];
  const result = await runBenchmark({
    targetLines: requested ? Number.parseInt(requested, 10) : undefined,
    log: (line) => console.log(line),
  });
  console.log("");
  console.log(formatReport(result));
}
