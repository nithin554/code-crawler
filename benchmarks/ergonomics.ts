import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";
import { createServer } from "../src/server.js";

/**
 * Agent-ergonomics benchmark: graph tool calls versus grep-and-read.
 *
 * For each realistic task this runs the graph path against the real MCP server
 * and, separately, models what an agent does with only text search: one search
 * per query, then reading every file the search hit, because text cannot tell
 * you which enclosing method matched or who dispatches to it.
 *
 * Both sides are measured with the same 4-chars-per-token heuristic the server
 * uses for its own budget, and calls are counted the same way (one tool call on
 * the graph side, one search or one file read on the grep side).
 *
 * The baseline is deliberately generous to grep in three ways, so the numbers
 * understate the graph's advantage rather than overstate it:
 *   1. reads are capped at MAX_READ_FILES, after which the baseline stops
 *      paying even though the answer is incomplete;
 *   2. the per-declaration baseline is handed the symbol list for free and
 *      only pays to verify it;
 *   3. no re-searching after an ambiguous hit, which a real agent would do.
 *
 * The numbers describe these ten tasks on these pinned projects. They are not
 * a claim about every query: see the "where plain search wins" tasks, which are
 * reported in the same table and lose for the graph.
 */

const ROOT = process.cwd();
const CACHE = path.join(ROOT, "benchmarks", ".cache");
const MAX_READ_FILES = 20;
const EXCLUDED = /(^|[\\/])(\.git|node_modules|__pycache__|\.venv|dist|build|\.m2|target)([\\/]|$)/;

/** Same heuristic as `estimateTokens` in the server, applied to raw text. */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface GraphCall {
  tool: string;
  args?: Record<string, unknown>;
}

type GrepPlan =
  /** The matching lines are the answer (a textual question). */
  | { kind: "search-only"; pattern: string }
  /** The answer needs structure, so each hit file must be opened. */
  | { kind: "search-and-read"; pattern: string }
  /** Dead-code review: one search per declaration to verify. */
  | { kind: "per-declaration"; names: string[]; tool: GraphCall };

interface Task {
  id: string;
  question: string;
  project: string;
  category: "who-calls" | "endpoint" | "impact" | "dead-code" | "search-wins";
  /** Extensions the text search would consider. */
  exts: string[];
  graph: GraphCall[];
  grep: GrepPlan;
  /** Override the automatic "did the payload contain evidence" check. */
  graphAnswers?: boolean;
  /** Why the graph payload is not the answer, when it is not. */
  graphNote?: string;
}

const TASKS: Task[] = [
  {
    id: "petclinic-who-calls-findAll",
    question: "Who calls OwnerRepository.findAll?",
    project: "spring-petclinic",
    category: "who-calls",
    exts: [".java"],
    graph: [
      {
        tool: "get_callers",
        args: { symbol: "org.springframework.samples.petclinic.owner.OwnerRepository#findAll" },
      },
    ],
    grep: { kind: "search-and-read", pattern: "findAll\\(" },
  },
  {
    id: "petclinic-endpoint-chain",
    question: "What runs on GET /owners/{ownerId}?",
    project: "spring-petclinic",
    category: "endpoint",
    exts: [".java"],
    graph: [
      { tool: "find_routes", args: { limit: 50 } },
      {
        tool: "trace_execution",
        args: {
          symbol: "org.springframework.samples.petclinic.owner.OwnerController#showOwner",
          max_depth: 3,
        },
      },
    ],
    grep: { kind: "search-and-read", pattern: "showOwner|owners/\\{ownerId\\}" },
  },
  {
    id: "petclinic-impact-pet",
    question: "What breaks if I change the Pet entity?",
    project: "spring-petclinic",
    category: "impact",
    exts: [".java"],
    graph: [
      {
        tool: "impact_analysis",
        args: { symbol: "org.springframework.samples.petclinic.owner.Pet" },
      },
    ],
    grep: { kind: "search-and-read", pattern: "\\bPet\\b" },
  },
  {
    id: "petclinic-dead-code",
    question: "Which package-level declarations are dead?",
    project: "spring-petclinic",
    category: "dead-code",
    exts: [".java"],
    graph: [{ tool: "find_dead_code", args: { limit: 200 } }],
    grep: {
      kind: "per-declaration",
      names: [],
      tool: { tool: "find_dead_code", args: { limit: 200 } },
    },
  },
  {
    id: "realworld-who-calls-getId",
    question: "Who calls User.getId?",
    project: "spring-boot-realworld",
    category: "who-calls",
    exts: [".java"],
    graph: [{ tool: "get_callers", args: { symbol: "io.spring.core.user.User#getId" } }],
    grep: { kind: "search-and-read", pattern: "\\.getId\\(\\)" },
  },
  {
    id: "realworld-callees-query-service",
    question: "What does ArticleQueryService.findById reach?",
    project: "spring-boot-realworld",
    category: "who-calls",
    exts: [".java"],
    graph: [
      {
        tool: "get_callees",
        args: { symbol: "io.spring.application.ArticleQueryService#findById" },
      },
    ],
    grep: { kind: "search-and-read", pattern: "findById\\(" },
  },
  {
    id: "fastapi-deps",
    question: "Who depends on get_current_user?",
    project: "fastapi-template",
    category: "who-calls",
    exts: [".py"],
    graph: [
      {
        tool: "find_injections",
        args: { symbol: "module:backend.app.api.deps#get_current_user" },
      },
    ],
    grep: { kind: "search-and-read", pattern: "get_current_user" },
  },
  {
    id: "fastapi-items-endpoint",
    question: "What runs on POST /items?",
    project: "fastapi-template",
    category: "endpoint",
    exts: [".py"],
    graph: [
      { tool: "find_routes", args: { limit: 50 } },
      {
        tool: "trace_execution",
        args: { symbol: "module:backend.app.api.routes.items", max_depth: 3 },
      },
    ],
    grep: { kind: "search-and-read", pattern: "@router\\.(post|get).*|/items" },
  },
  {
    id: "nestjs-who-calls-article-create",
    question: "Who calls ArticleService.create?",
    project: "nestjs-realworld",
    category: "who-calls",
    exts: [".ts"],
    graph: [
      {
        tool: "get_callers",
        args: { symbol: "src.article.article.service.ArticleService#create" },
      },
    ],
    grep: { kind: "search-and-read", pattern: "articleService\\.create|ArticleService" },
  },
  {
    id: "nestjs-impact-entity",
    question: "What breaks if I change ArticleEntity?",
    project: "nestjs-realworld",
    category: "impact",
    exts: [".ts"],
    graph: [
      { tool: "impact_analysis", args: { symbol: "src.article.article.entity.ArticleEntity" } },
    ],
    grep: { kind: "search-and-read", pattern: "ArticleEntity" },
  },
  {
    id: "petclinic-grep-wins-template-key",
    question: "Which templates use the i18n key 'welcome'?",
    project: "spring-petclinic",
    category: "search-wins",
    exts: [".html", ".properties", ".java"],
    graph: [{ tool: "search_symbols", args: { query: "welcome" } }],
    grep: { kind: "search-only", pattern: "welcome" },
    graphAnswers: false,
    graphNote:
      "search_symbols matches symbol names; it does not index template text, so the payload lists same-named symbols rather than the templates that use the key",
  },
  {
    id: "petclinic-grep-wins-sql",
    question: "Where is the owner search SQL defined?",
    project: "spring-petclinic",
    category: "search-wins",
    exts: [".java", ".xml"],
    graph: [{ tool: "search_symbols", args: { query: "findByLastName" } }],
    grep: { kind: "search-only", pattern: "findByLastName" },
  },
];

interface Measurement {
  calls: number;
  tokens: number;
  notes: string[];
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (EXCLUDED.test(full)) continue;
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

interface SearchResult {
  hits: Array<{ file: string; text: string }>;
}

function search(files: string[], pattern: RegExp, base: string): SearchResult {
  const hits: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i] ?? "")) {
        hits.push({
          file,
          text: `${path.relative(base, file).replace(/\\/g, "/")}:${i + 1}: ${(lines[i] ?? "").trim()}`,
        });
      }
    }
  }
  return { hits };
}

/** Model an agent working from text search alone. */
function measureGrep(task: Task, base: string): Measurement {
  const files = walk(base, task.exts);
  const notes: string[] = [];
  const runSearch = (pattern: RegExp): { cost: number; files: string[] } => {
    const { hits } = search(files, pattern, base);
    const distinct = [...new Set(hits.map((h) => h.file))].sort();
    return {
      cost: tokens(hits.map((h) => h.text).join("\n")),
      files: distinct,
    };
  };

  if (task.grep.kind === "per-declaration") {
    let calls = 0;
    let cost = 0;
    const distinctFiles = new Set<string>();
    for (const name of task.grep.names) {
      const r = runSearch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
      calls += 1;
      cost += r.cost;
      for (const f of r.files) distinctFiles.add(f);
    }
    // Verifying each candidate means opening the declaring file.
    for (const file of [...distinctFiles].sort().slice(0, MAX_READ_FILES)) {
      calls += 1;
      cost += tokens(fs.readFileSync(file, "utf8"));
    }
    if (distinctFiles.size > MAX_READ_FILES)
      notes.push(`reads capped at ${MAX_READ_FILES} of ${distinctFiles.size} files`);
    notes.push(`${task.grep.names.length} declarations searched one at a time`);
    return { calls, tokens: cost, notes };
  }

  const { cost, files: hitFiles } = runSearch(new RegExp(task.grep.pattern, "m"));
  if (task.grep.kind === "search-only") {
    notes.push(`${hitFiles.length} files matched, search output is the answer`);
    return { calls: 1, tokens: cost, notes };
  }
  const read = hitFiles.slice(0, MAX_READ_FILES);
  let total = cost;
  for (const file of read) total += tokens(fs.readFileSync(file, "utf8"));
  if (hitFiles.length > read.length)
    notes.push(`reads capped at ${MAX_READ_FILES} of ${hitFiles.length} files`);
  notes.push(`${hitFiles.length} files matched`);
  return { calls: 1 + read.length, tokens: total, notes };
}

async function measureGraph(
  client: Client,
  task: Task,
  compact: boolean,
  base: string
): Promise<{ measurement: Measurement; outputs: Record<string, unknown> }> {
  // Payloads embed absolute file paths, so strip the checkout prefix before
  // counting: the same graph must cost the same on a CI runner.
  const strip = (text: string): string =>
    text.split(base.replace(/\\/g, "\\\\")).join("<proj>").split(base).join("<proj>");
  let calls = 0;
  let total = 0;
  const notes: string[] = [];
  const outputs: Record<string, unknown> = {};
  for (const step of task.graph) {
    const args = { ...(step.args ?? {}), ...(compact ? { compact: true } : {}) };
    const result = (await client.callTool({ name: step.tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const raw = result.content?.find((c) => c.type === "text")?.text;
    if (typeof raw !== "string") throw new Error(`${step.tool} returned no text`);
    const text = strip(raw);
    calls += 1;
    total += tokens(text);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    outputs[step.tool] = parsed;
    if (result.isError) notes.push(`${step.tool} returned an error`);
  }
  return { measurement: { calls, tokens: total, notes }, outputs };
}

interface Row {
  requirement: Task;
  full: Measurement;
  compact: Measurement;
  grep: Measurement;
  graphAnswered: boolean;
}

/** Did the graph path actually produce evidence, rather than an empty envelope? */
function answered(outputs: Record<string, unknown>): boolean {
  const first = Object.values(outputs)[0];
  if (!first || typeof first !== "object") return false;
  const record = first as Record<string, unknown>;
  for (const key of [
    "callers",
    "callees",
    "steps",
    "routes",
    "injections",
    "symbols",
    "unused",
    "deadCode",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length > 0;
  }
  const results = record.results;
  if (Array.isArray(results)) return results.length > 0;
  return Object.keys(record).length > 0;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "benchmarks", "manifest.json"), "utf8")
  ) as { projects: Array<{ name: string; commit: string; subPath: string }> };

  const projects = new Map<string, { dir: string; subPath: string }>();
  for (const spec of manifest.projects) {
    const dir = path.join(CACHE, spec.name);
    if (!fs.existsSync(path.join(dir, ".git")))
      throw new Error(
        `${spec.name} is not cached; run \`npm run bench:accuracy\` once to clone the pinned projects`
      );
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    if (!head.includes(spec.commit) && !fs.existsSync(path.join(dir, ".git", "refs")))
      console.warn(`warning: ${spec.name} cache may not be at ${spec.commit.slice(0, 12)}`);
    projects.set(spec.name, { dir: path.join(dir, spec.subPath), subPath: spec.subPath });
  }

  const rows: Row[] = [];
  for (const name of new Set(TASKS.map((t) => t.project))) {
    const proj = projects.get(name);
    if (!proj) throw new Error(`unknown project ${name}`);
    const config = loadConfig({ projectRoot: proj.dir });
    const store = new GraphStore(":memory:", { maxDepth: config.maxDepth });
    await crawlProject(store, proj.dir, config.excludeDirs, {
      respectGitignore: config.respectGitignore,
      maxFileBytes: config.maxFileBytes,
      force: true,
    });
    const server: McpServer = createServer(store, config);
    const client = new Client({ name: "bench-ergonomics", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    for (const task of TASKS.filter((t) => t.project === name)) {
      // `find_dead_code` hands the baseline the declarations it must verify.
      if (task.grep.kind === "per-declaration" && task.grep.names.length === 0) {
        const probe = await measureGraph(client, task, false, proj.dir);
        const payload = probe.outputs[task.grep.tool.tool] as Record<string, unknown> | undefined;
        const list = (["unused", "deadCode", "symbols", "results"]
          .map((key) => payload?.[key])
          .find((value): value is Array<Record<string, unknown>> => Array.isArray(value)) ??
          []) as Array<Record<string, unknown>>;
        const names = [
          ...new Set(
            list
              .map((item) => {
                const ref = item.symbol as { name?: unknown } | undefined;
                return typeof ref?.name === "string" ? ref.name : item.name;
              })
              .filter((n): n is string => typeof n === "string")
          ),
        ].slice(0, 40);
        if (names.length === 0)
          throw new Error(`${task.id}: find_dead_code returned no declarations to search for`);
        task.grep.names = names;
      }
      const full = await measureGraph(client, task, false, proj.dir);
      const compact = await measureGraph(client, task, true, proj.dir);
      rows.push({
        requirement: task,
        full: full.measurement,
        compact: compact.measurement,
        grep: measureGrep(task, proj.dir),
        graphAnswered: task.graphAnswers ?? answered(full.outputs),
      });
    }

    await client.close();
    store.close();
  }

  const pct = (base: number, value: number): string =>
    base === 0 ? "n/a" : `${Math.round((1 - value / base) * 100)}%`;

  const structural = rows.filter((r) => r.requirement.category !== "search-wins");
  const textual = rows.filter((r) => r.requirement.category === "search-wins");

  const table = (subset: Row[]): string[] => {
    const out = [
      "| # | Task | Project | Graph calls | Graph tokens | Compact tokens | Grep calls | Grep tokens |",
      "|---|------|---------|------------:|-------------:|---------------:|-----------:|------------:|",
    ];
    subset.forEach((row, i) => {
      const t = row.requirement;
      out.push(
        `| ${i + 1} | ${t.question} | ${t.project} | ${row.full.calls} | ${row.full.tokens} | ${row.compact.tokens} | ${row.grep.calls} | ${row.grep.tokens} |`
      );
    });
    return out;
  };

  const lines: string[] = [];
  lines.push(...table(structural));

  const sum = (subset: Row[], pick: (r: Row) => number): number =>
    subset.reduce((n, r) => n + pick(r), 0);
  const graphTokens = sum(structural, (r) => r.full.tokens);
  const compactTokens = sum(structural, (r) => r.compact.tokens);
  const grepTokens = sum(structural, (r) => r.grep.tokens);
  const graphCalls = sum(structural, (r) => r.full.calls);
  const grepCalls = sum(structural, (r) => r.grep.calls);

  lines.push("");
  lines.push(
    `Structural tasks (${structural.length}): graph ${graphCalls} calls / ${graphTokens} tokens; compact ${compactTokens} tokens (${pct(graphTokens, compactTokens)} smaller); grep-and-read ${grepCalls} calls / ${grepTokens} tokens. The graph reads ${pct(grepTokens, graphTokens)} fewer tokens than grep-and-read, ${pct(grepTokens, compactTokens)} fewer with compact.`
  );
  lines.push("");
  lines.push(
    `Graph answered ${structural.filter((r) => r.graphAnswered).length}/${structural.length} structural tasks with a payload that is the answer:`
  );
  for (const row of structural)
    if (!row.graphAnswered)
      lines.push(
        `  - NOT answered: ${row.requirement.question} - ${row.requirement.graphNote ?? "empty payload"}`
      );
  lines.push("");
  lines.push("Per-category token totals (graph / graph compact / grep-and-read):");
  for (const category of [...new Set(structural.map((r) => r.requirement.category))]) {
    const of = structural.filter((r) => r.requirement.category === category);
    lines.push(
      `  - ${category}: ${sum(of, (r) => r.full.tokens)} / ${sum(of, (r) => r.compact.tokens)} / ${sum(of, (r) => r.grep.tokens)}`
    );
  }

  lines.push("");
  lines.push("Where plain search wins (not part of the totals above):");
  lines.push("");
  lines.push(...table(textual));
  lines.push("");
  for (const row of textual) {
    const t = row.requirement;
    const verdict = !row.graphAnswered
      ? "grep wins: the graph has no answer"
      : row.grep.tokens < row.compact.tokens
        ? "grep wins"
        : "graph wins";
    lines.push(
      `- ${t.question} - ${verdict}. grep ${row.grep.calls} call / ${row.grep.tokens} tokens vs graph ${row.full.calls} call / ${row.full.tokens} tokens (${row.compact.tokens} compact).`
    );
    if (t.graphNote) lines.push(`  ${t.graphNote}.`);
  }

  lines.push("");
  lines.push("Baseline notes:");
  for (const row of structural.concat(textual))
    if (row.grep.notes.length > 0)
      lines.push(`  - ${row.requirement.id}: ${row.grep.notes.join("; ")}`);

  const report = lines.join("\n");
  console.log(report);
  const reports = path.join(ROOT, "benchmarks", "reports");
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, "ergonomics.md"), `${report}\n`, "utf8");
}

await main();
