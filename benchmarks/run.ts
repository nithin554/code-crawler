import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";

/**
 * Accuracy benchmark.
 *
 * Each case asserts whether one specific edge exists in the graph for a pinned
 * third-party project. `expected: "present"` cases measure recall (did we find
 * the edge the source really has?); `expected: "absent"` cases measure
 * specificity (did we invent an edge that does not exist?). Both are needed:
 * a graph that emits everything has perfect recall and no value.
 *
 * Answers come from hand reading of the pinned source, never from the graph, so
 * the benchmark can fail. Runtime-derived cases carry `source: "runtime"` and a
 * description of the run that produced them.
 *
 * The numbers are sample-level: they describe the labelled cases, not every
 * edge in the graph. `globalConfidence` reports the whole graph for context.
 */

interface RouteExpectation {
  httpMethod?: string;
  path?: string;
}

interface BenchCase {
  id: string;
  edgeKind: string;
  from: string;
  to: string;
  expected: "present" | "absent";
  source: "hand" | "runtime";
  note: string;
  route?: RouteExpectation;
}

interface CaseFile {
  project: string;
  language: string;
  framework: string;
  cases: BenchCase[];
}

interface ProjectSpec {
  name: string;
  repo: string;
  commit: string;
  /** Directory inside the repository to crawl, relative to the clone root. */
  subPath: string;
  language: string;
  framework: string;
  /** Why this commit, and anything a reader needs to judge the ground truth. */
  note: string;
}

interface Manifest {
  projects: ProjectSpec[];
  /** How the floors were chosen. Rendered into the report so the numbers are auditable. */
  _comment?: string;
  /** Floors applied to every edge kind that has labelled cases. */
  thresholds: {
    default: { precision: number; recall: number };
    perEdgeKind?: Record<string, { precision: number; recall: number }>;
  };
}

interface Outcome {
  project: string;
  language: string;
  id: string;
  edgeKind: string;
  expected: BenchCase["expected"];
  outcome: "TP" | "FP" | "FN" | "TN";
  reason?: string;
  note: string;
}

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CACHE = path.join(ROOT, ".cache");
const REPORTS = path.join(ROOT, "reports");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Clone `spec` at its pinned commit into the cache, or verify the cached copy. */
function ensureProject(spec: ProjectSpec): string {
  const dir = path.join(CACHE, spec.name);
  if (fs.existsSync(path.join(dir, ".git"))) {
    const head = git(["rev-parse", "HEAD"], dir);
    if (head === spec.commit) return dir;
    // Cache restored at the wrong revision: start clean rather than benchmark the wrong code.
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--quiet"], dir);
  git(["remote", "add", "origin", spec.repo], dir);
  git(["fetch", "--quiet", "--depth", "1", "origin", spec.commit], dir);
  git(["checkout", "--quiet", "FETCH_HEAD"], dir);
  const head = git(["rev-parse", "HEAD"], dir);
  if (head !== spec.commit) throw new Error(`${spec.name}: checked out ${head}, expected ${spec.commit}`);
  return dir;
}

interface CrawlSummary {
  nodes: number;
  edges: number;
  files: number;
  filesParsed: number;
  filesScanned: number;
  parseErrors: string[];
  durationMs: number;
  edgeCounts: Record<string, number>;
}

async function crawl(dir: string): Promise<{ store: GraphStore; summary: CrawlSummary }> {
  const config = loadConfig({ projectRoot: dir });
  const store = new GraphStore(":memory:", { maxDepth: config.maxDepth });
  const result = await crawlProject(store, dir, config.excludeDirs, {
    respectGitignore: config.respectGitignore,
    maxFileBytes: config.maxFileBytes,
    force: true,
  });
  const stats = store.stats();
  const edgeCounts: Record<string, number> = {};
  for (const row of store.raw<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind"
  ))
    edgeCounts[row.kind] = row.n;
  return {
    store,
    summary: {
      nodes: stats.nodes,
      edges: stats.edges,
      files: stats.files,
      filesParsed: result.filesParsed,
      filesScanned: result.filesScanned,
      parseErrors: result.parseErrors ?? [],
      durationMs: result.durationMs,
      edgeCounts,
    },
  };
}

function findEdge(
  store: GraphStore,
  edgeKind: string,
  from: string,
  to: string
): Record<string, unknown> | null {
  const rows = store.raw<{ properties: string }>(
    `SELECT e.properties AS properties
       FROM edges e
       JOIN nodes ns ON ns.id = e.source
       JOIN nodes nt ON nt.id = e.target
      WHERE e.kind = ? AND ns.qualified_name = ? AND nt.qualified_name = ?`,
    edgeKind,
    from,
    to
  );
  const first = rows[0];
  if (!first) return null;
  return JSON.parse(first.properties) as Record<string, unknown>;
}

function nodeExists(store: GraphStore, qualifiedName: string): boolean {
  return store.raw("SELECT 1 AS ok FROM nodes WHERE qualified_name = ? LIMIT 1", qualifiedName).length > 0;
}

function evaluate(store: GraphStore, project: string, language: string, c: BenchCase): Outcome {
  const props = findEdge(store, c.edgeKind, c.from, c.to);
  const base = {
    project,
    language,
    id: c.id,
    edgeKind: c.edgeKind,
    expected: c.expected,
    note: c.note,
  };

  if (c.expected === "absent") {
    if (!props) return { ...base, outcome: "TN" };
    return { ...base, outcome: "FP", reason: `invented edge ${c.edgeKind}` };
  }

  if (!props) {
    const missing: string[] = [];
    if (!nodeExists(store, c.from)) missing.push(`from:${c.from}`);
    if (!nodeExists(store, c.to)) missing.push(`to:${c.to}`);
    return {
      ...base,
      outcome: "FN",
      reason: missing.length > 0 ? `unindexed node ${missing.join(", ")}` : "edge missing",
    };
  }

  if (c.route) {
    const wrong: string[] = [];
    if (c.route.httpMethod && props.httpMethod !== c.route.httpMethod)
      wrong.push(`httpMethod ${String(props.httpMethod)} != ${c.route.httpMethod}`);
    if (c.route.path && props.path !== c.route.path)
      wrong.push(`path ${String(props.path)} != ${c.route.path}`);
    if (wrong.length > 0) return { ...base, outcome: "FN", reason: `wrong route: ${wrong.join("; ")}` };
  }

  return { ...base, outcome: "TP" };
}

interface Tally {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function emptyTally(): Tally {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

function add(t: Tally, o: Outcome): void {
  if (o.outcome === "TP") t.tp++;
  else if (o.outcome === "FP") t.fp++;
  else if (o.outcome === "FN") t.fn++;
  else t.tn++;
}

function scores(t: Tally): { precision: number | null; recall: number | null } {
  const precision = t.tp + t.fp === 0 ? null : t.tp / (t.tp + t.fp);
  const recall = t.tp + t.fn === 0 ? null : t.tp / (t.tp + t.fn);
  return { precision, recall };
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

/** Confidence histogram over every edge of a kind in the crawled graph. */
function globalConfidence(store: GraphStore): Record<string, Record<string, number>> {
  const rows = store.raw<{ kind: string; properties: string }>("SELECT kind, properties FROM edges");
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const bucket = out[row.kind] ?? (out[row.kind] = {});
    let key = "none";
    try {
      const props = JSON.parse(row.properties) as { confidence?: number };
      if (typeof props.confidence === "number") key = props.confidence.toFixed(2);
    } catch {
      key = "unparsed";
    }
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const caseDir = path.join(ROOT, "cases");
  const caseFiles = fs
    .readdirSync(caseDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<CaseFile>(path.join(caseDir, f)));

  const byKind: Record<string, Tally> = {};
  const byLanguage: Record<string, Tally> = {};
  const byProject: Record<string, Tally> = {};
  const outcomes: Outcome[] = [];
  const projects: Array<ProjectSpec & { crawl: CrawlSummary; confidence: Record<string, Record<string, number>> }> = [];

  for (const spec of manifest.projects) {
    const dir = ensureProject(spec);
    process.stderr.write(`crawling ${spec.name} @ ${spec.commit.slice(0, 12)} ... `);
    const { store, summary } = await crawl(path.join(dir, spec.subPath));
    process.stderr.write(
      `${summary.filesParsed}/${summary.filesScanned} files, ${summary.nodes} nodes, ` +
        `${summary.edges} edges, ${summary.durationMs}ms\n`
    );
    projects.push({ ...spec, crawl: summary, confidence: globalConfidence(store) });

    const file = caseFiles.find((c) => c.project === spec.name);
    if (!file) throw new Error(`no case file for project ${spec.name}`);
    for (const c of file.cases) {
      const outcome = evaluate(store, spec.name, file.language, c);
      outcomes.push(outcome);
      add(byKind[c.edgeKind] ?? (byKind[c.edgeKind] = emptyTally()), outcome);
      add(byLanguage[file.language] ?? (byLanguage[file.language] = emptyTally()), outcome);
      add(byProject[spec.name] ?? (byProject[spec.name] = emptyTally()), outcome);
      if (outcome.outcome === "FN" || outcome.outcome === "FP")
        process.stderr.write(`  ✗ ${spec.name}/${c.id}: ${outcome.reason ?? outcome.outcome}\n`);
    }
    store.close();
  }

  // Gate: every edge kind with labelled cases must clear its floor.
  const violations: string[] = [];
  for (const [kind, tally] of Object.entries(byKind)) {
    const floor = manifest.thresholds.perEdgeKind?.[kind] ?? manifest.thresholds.default;
    const { precision, recall } = scores(tally);
    if (precision !== null && precision < floor.precision)
      violations.push(`${kind} precision ${fmt(precision)} < ${floor.precision}`);
    if (recall !== null && recall < floor.recall)
      violations.push(`${kind} recall ${fmt(recall)} < ${floor.recall}`);
  }

  const totals = emptyTally();
  for (const o of outcomes) add(totals, o);

  const lines: string[] = [];
  lines.push("# Code-Crawler accuracy benchmark", "");
  lines.push(
    "Sample-level accuracy of the graph against hand-verified (and where noted, runtime-verified)",
    "expectations for pinned open-source projects. Precision here means: of the labelled edges the",
    "graph was asked about, how many it answered correctly kept. It is not a claim about every edge",
    "in the graph.",
    ""
  );
  lines.push("## Projects", "");
  lines.push("| project | language | framework | commit | files | nodes | edges | crawl |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of projects) {
    lines.push(
      `| ${p.name} | ${p.language} | ${p.framework} | \`${p.commit.slice(0, 12)}\` | ` +
        `${p.crawl.filesParsed}/${p.crawl.filesScanned} | ${p.crawl.nodes} | ${p.crawl.edges} | ` +
        `${p.crawl.durationMs} ms |`
    );
  }
  lines.push("");
  lines.push("## Ground-truth provenance", "");
  lines.push(
    "Every case below was derived by reading the pinned source, not by querying the graph, so the",
    "benchmark is able to fail. Cases marked `runtime` additionally carry evidence from an actual",
    "execution. Cases marked `hand` are hand-verified static truth: they reflect what the code",
    "genuinely does at runtime (for example a Lombok-generated constructor or a Spring mapping",
    "annotation), but no execution trace was captured to prove it.",
    ""
  );
  for (const p of projects) {
    lines.push(`- **${p.name}** (\`${p.commit}\`): ${p.note}`);
  }
  lines.push("");
  lines.push("## Per edge type", "");
  lines.push("| edge kind | cases | precision | recall | TP | FP | FN | TN |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [kind, tally] of Object.entries(byKind).sort()) {
    const { precision, recall } = scores(tally);
    const n = tally.tp + tally.fp + tally.fn + tally.tn;
    lines.push(
      `| ${kind} | ${n} | ${fmt(precision)} | ${fmt(recall)} | ${tally.tp} | ${tally.fp} | ${tally.fn} | ${tally.tn} |`
    );
  }
  lines.push("");
  lines.push("## Per language", "");
  lines.push("| language | cases | precision | recall | TP | FP | FN | TN |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [lang, tally] of Object.entries(byLanguage).sort()) {
    const { precision, recall } = scores(tally);
    const n = tally.tp + tally.fp + tally.fn + tally.tn;
    lines.push(
      `| ${lang} | ${n} | ${fmt(precision)} | ${fmt(recall)} | ${tally.tp} | ${tally.fp} | ${tally.fn} | ${tally.tn} |`
    );
  }
  lines.push("");
  lines.push("## Per project", "");
  lines.push("| project | cases | precision | recall | TP | FP | FN | TN |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of projects) {
    const tally = byProject[p.name] ?? emptyTally();
    const { precision, recall } = scores(tally);
    const n = tally.tp + tally.fp + tally.fn + tally.tn;
    lines.push(
      `| ${p.name} | ${n} | ${fmt(precision)} | ${fmt(recall)} | ${tally.tp} | ${tally.fp} | ${tally.fn} | ${tally.tn} |`
    );
  }
  lines.push("");
  lines.push("## Confidence distribution (whole graph, not just labelled cases)", "");
  lines.push("| project | edge kind | confidence buckets |");
  lines.push("| --- | --- | --- |");
  for (const p of projects) {
    for (const [kind, buckets] of Object.entries(p.confidence).sort()) {
      const rendered = Object.entries(buckets)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      lines.push(`| ${p.name} | ${kind} | ${rendered} |`);
    }
  }
  lines.push("");
  const failures = outcomes.filter((o) => o.outcome === "FN" || o.outcome === "FP");
  lines.push("## Misses and false positives", "");
  if (failures.length === 0) lines.push("None.");
  for (const f of failures.sort((a, b) => a.project.localeCompare(b.project))) {
    lines.push(`- **${f.project}/${f.id}** (${f.edgeKind}, expected ${f.expected}): ${f.reason}. ${f.note}`);
  }
  lines.push("");
  lines.push("## Parse errors", "");
  const withErrors = projects.filter((p) => p.crawl.parseErrors.length > 0);
  if (withErrors.length === 0) lines.push("None: every candidate file was parsed.");
  for (const p of withErrors) {
    lines.push(`- **${p.name}**: ${p.crawl.parseErrors.length} file(s)`);
    for (const err of p.crawl.parseErrors.slice(0, 10)) lines.push(`  - ${path.basename(err)}`);
  }
  lines.push("");
  lines.push("## Threshold floors", "");
  if (manifest._comment) {
    lines.push(manifest._comment, "");
  }
  lines.push(
    "Floors are ratchets: they sit at the value last measured, so an improvement passes and any",
    "regression fails the build. Precision floors are 1.000 because a confidently wrong edge is",
    "worse than a missing one, so the benchmark refuses to let a single invented edge through.",
    ""
  );
  lines.push("| edge kind | precision floor | measured | recall floor | measured |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [kind, tally] of Object.entries(byKind)) {
    const floor = manifest.thresholds.perEdgeKind?.[kind] ?? manifest.thresholds.default;
    const { precision, recall } = scores(tally);
    lines.push(
      `| ${kind} | ${fmt(floor.precision)} | ${fmt(precision)} | ${fmt(floor.recall)} | ${fmt(recall)} |`
    );
  }
  lines.push("");
  if (violations.length > 0) {
    lines.push("## Threshold violations", "");
    for (const v of violations) lines.push(`- ${v}`);
    lines.push("");
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, "accuracy.md"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(
    path.join(REPORTS, "accuracy.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projects: projects.map((p) => ({
          name: p.name,
          commit: p.commit,
          language: p.language,
          framework: p.framework,
          note: p.note,
          crawl: p.crawl,
        })),
        byEdgeKind: Object.fromEntries(
          Object.entries(byKind).map(([k, t]) => [k, { ...t, ...scores(t) }])
        ),
        byLanguage: Object.fromEntries(
          Object.entries(byLanguage).map(([k, t]) => [k, { ...t, ...scores(t) }])
        ),
        byProject: Object.fromEntries(
          Object.entries(byProject).map(([k, t]) => [k, { ...t, ...scores(t) }])
        ),
        totals,
        outcomes,
        violations,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  for (const [kind, tally] of Object.entries(byKind).sort()) {
    const { precision, recall } = scores(tally);
    console.log(
      `${kind.padEnd(18)} n=${String(tally.tp + tally.fp + tally.fn + tally.tn).padStart(3)}  ` +
        `precision=${fmt(precision)}  recall=${fmt(recall)}`
    );
  }
  console.log(
    `\ntotal: ${totals.tp} matched, ${totals.fn} missed, ${totals.fp} invented, ${totals.tn} correctly absent`
  );
  console.log(`report: ${path.relative(process.cwd(), path.join(REPORTS, "accuracy.md"))}`);

  if (violations.length > 0) {
    console.error("\naccuracy regressions:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  }
}

function loadManifest(): Manifest {
  const file = path.join(ROOT, "manifest.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read ${file}`);
  }
  // A UTF-8 BOM survives a round-trip through some Windows editors and makes JSON.parse throw
  // with a message that points at column 1, which is useless for diagnosis.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text) as Manifest;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

await main().catch((err: unknown) => {
  console.error(`benchmark failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
