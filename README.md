# Code-Crawler

**Static + dynamic call tracing MCP server backed by a persistent property graph of your codebase.**

Code-Crawler indexes a project into a SQLite-backed property graph — files, packages,
modules, classes, interfaces, methods, fields, imports, annotations/decorators, **call
edges**, **virtual dispatch**, **aspect advice**, and the wiring frameworks add
(**entry points**, **routes**, **injected dependencies**, **reflective lookups**) — then
exposes that graph to LLM clients as MCP tools: find callers, trace call paths, explore
neighborhoods, follow runtime dispatch, and search symbols across the whole codebase.

Supports **Java**, **Python**, **TypeScript**, and **JavaScript** projects, and can index
all of them into the same graph.

📖 **Documentation site:** <https://nithin554.github.io/code-crawler/>
📘 **Task-oriented guide:** [`USAGE.md`](USAGE.md)
🗺️ **Roadmap:** [`ROADMAP.md`](ROADMAP.md)

```
        ┌───────────────────────  MCP (stdio)  ───────────────────────┐
        │  crawl_project  search_symbols  get_callers  get_callees     │
        │  trace_path     trace_execution  find_aspects  get_decorators│
        │  find_implementations  find_hotspots  find_dead_code  ...    │
        └───────────────┬──────────────────────────────┬───────────────┘
                        │                              │
                 ┌──────▼───────┐             ┌────────▼────────┐
                 │   crawler    │             │  graph queries  │
                 │ parse+resolve│             │ recursive CTEs  │
                 └──────┬───────┘             └────────┬────────┘
                        │                              │
                 ┌──────▼──────────────────────────────▼──────┐
                 │        SQLite property graph (WAL)          │
                 │   nodes (kind, fqn, props) + edges (kind)   │
                 └─────────────────────────────────────────────┘
```

## Why a graph?

Plain-text grep can't answer questions like:

- *"Who transitively calls `OrderRepository#create`?"*
- *"Is there a static path from `Main#main` to `Tracking#dispatch`?"*
- *"What is the impact radius of changing `OrderService#place`?"*

These need graph traversal. Code-Crawler builds the graph once (idempotently, file-by-file)
and answers them with bounded recursive SQL queries.

## Features

- **Four languages, one graph**: Java (`tree-sitter-java`), Python
  (`tree-sitter-python`), TypeScript (`tree-sitter-typescript`, `tree-sitter-tsx`), and
  JavaScript (`tree-sitter-javascript`) — all WASM, no native build step.
  Language is detected per file, so a polyglot repo lands in a single graph.
- **Dynamic tracing on a static graph** — `DYNAMIC_DISPATCH` edges connect interface/base
  calls to every override in the project, and `ADVISES` edges weave AspectJ/Spring AOP
  advice into execution traces (`before`, `after`, `around`, `after-returning`,
  `after-throwing`, named `@Pointcut` references, `&&`/`||`/`!` and `execution`, `within`,
  `@annotation`, `@within`, `target`, `this`, `args` primitives).
- **Run-time indirection is named, not lost** — Java reflection/`ServiceLoader`, Python
  `getattr`/`importlib`, and JS `require`/dynamic `import()` produce `REFLECTS` edges to
  the resolved symbol when the target is statically determinable, or to a
  `__reflect__:` marker when it is not.
- **Framework wiring** — dependency injection (`@Autowired`, NestJS constructor
  injection, FastAPI `Depends`) becomes `INJECTS` edges, and HTTP routes
  (`@GetMapping`, `@RequestMapping`, NestJS `@Controller`/`@Get`, FastAPI/Flask
  decorators, Express `app.get`) become `ROUTES` edges to the handler, which is also
  marked as an entry point.
- **Control flow on call edges** — every `CALLS` edge records whether the call is
  conditional and the compact source text of its enclosing guards/loops, so an agent can
  tell a happy path from an error path without reading the file.
- **External dependencies are explicit** — third-party imports and runtime globals
  become package-level `external_symbol` nodes with `REFERENCES` edges and a
  `find_external_dependencies` summary, distinct from project code.
- **Annotations as first-class nodes** — `@Transactional`, `@Cacheable`, `@Async`,
  `@Retryable`, Python decorators, and TS decorators become `annotation` nodes with
  `ANNOTATED_WITH` edges, so you can query decorators on types, methods, and fields.
- **Call resolution heuristics** that go beyond naive string matching:
  receiver types inferred from locals, parameters, fields, `new T()` expressions,
  `self`/`this` scoping, dotted paths (`service.repo.find`), loop-variable element types,
  bare/`this`/`super` calls, static/qualified calls, and superclass chains.
  Unresolvable calls become `unknown_symbol` phantom nodes with `resolved:false` edges,
  so the graph stays traversable.
- **Incremental, file-scoped indexing** — each crawl records a per-file manifest
  (`size`, mtime, SHA-256) and replays the cached parse result for files whose content is
  unchanged, so a re-crawl re-parses only what actually changed. Changes are reported as
  `filesAdded` / `filesUpdated` / `filesUnchanged` / `filesRemoved`. Derived dynamic edges
  and orphan pruning are rebuilt only when something changed. A full re-crawl still removes
  files that disappeared, without duplicating the graph, and scoped crawls (`fileFilter` or a
  forced `language`) never remove files outside their scope. When a checkout, `rsync -t`, an
  mtime-preserving unzip, or clock skew restores an edit with the old size and mtime, the
  shortcut misses it — pass `force` (`--force` on the CLI) to re-parse everything.
- **FTS5-backed symbol search** — symbol lookup runs against an external-content FTS5 index
  with BM25 ranking and exact/prefix boosting, falling back to a `LIKE` scan only when FTS
  finds nothing. Search does not degrade as the graph grows.
- **Versioned schema with automatic migration** — the database carries a schema version and
  upgrades itself in place on open. A database written by a newer build is rejected with a
  clear message instead of being read as if the shape were known.
- **A database per project** — the index lives in `<project>/.code-crawler/index.db`, so two
  repositories can never collide. Pointing a populated database at a different project fails
  with a `clear_index` hint instead of silently wiping the first index.
- **Analytics** — hotspots (fan-in/fan-out/advice counts) and dead-code candidates.
- **Self-contained**: single SQLite file, no external services.
- **LLM-friendly**: every tool returns structured JSON, unknown symbols come back with
  fuzzy search suggestions.

## Install & build

Requires Node.js ≥ 22.12 (`better-sqlite3@13` and the Vitest toolchain both need it).

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest (full suite; set CODECRAWLER_BENCH=1 for the scale test)
npm run lint         # biome check (lint + format, fails CI)
npm run format       # biome format --write
npm run coverage     # vitest run --coverage (thresholds in vitest.config.ts)
npm run bench        # crawl/query benchmark on a generated ~137k-line project
```

## CLI

```bash
codecrawler crawl <path>     # index a project
codecrawler crawl <path> --force  # re-parse every file, ignoring cached metadata
codecrawler status           # index summary
codecrawler query <symbol>   # fuzzy-lookup a symbol
codecrawler serve            # start the MCP server over stdio (default)
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODECRAWLER_DB` | `<project>/.code-crawler/index.db` | Database path. Resolved from the cwd upward, so each project gets its own file; falls back to `~/.code-crawler/index.db` when no project encloses the cwd. The home directory is only that fallback, never an enclosing project |
| `CODECRAWLER_EXCLUDE_DIRS` | `.git,node_modules,dist,build,target,...` | Dirs skipped during crawl |
| `CODECRAWLER_DEFAULT_LIMIT` | `50` | Default result cap |
| `CODECRAWLER_MAX_DEPTH` | `10` | Traversal depth cap (1–100) |
| `CODECRAWLER_MAX_FILE_BYTES` | `1000000` | Files larger than this are skipped, not parsed |
| `CODECRAWLER_RESPECT_GITIGNORE` | `true` | Honor the project's `.gitignore` during discovery |
| `CODECRAWLER_HELPFUL_ERRORS` | `true` | Fuzzy suggestions on symbol misses |
| `CODECRAWLER_PLUGIN` | unset | Plugin mode: resolve one database per project at call time instead of opening one file at startup |
| `CODECRAWLER_PLUGIN_ROOT` | unset | Plugin install directory, never indexed as a project |
| `CODECRAWLER_PLUGIN_DATA` | temp dir | Writable directory for the no-project fallback database |

Invalid values never crash the server: booleans fall back to their default and
integers are clamped to their documented range, each with a one-line warning on
stderr.

## What gets indexed

`crawl` walks the project and skips `.git`, `node_modules`, build output, and
other `CODECRAWLER_EXCLUDE_DIRS` entries. On top of that:

- the project's **`.gitignore`** is honored (disable with
  `CODECRAWLER_RESPECT_GITIGNORE=false`),
- an optional **`.crawlerrc`** in the project root can narrow or widen discovery
  with gitignore-style globs:

  ```json
  { "include": ["src/", "packages/core/"], "exclude": ["**/generated/"] }
  ```

  When `include` is non-empty, only matching files are indexed. A malformed
  `.crawlerrc` is ignored with a warning rather than failing the crawl.
- files above `CODECRAWLER_MAX_FILE_BYTES` and files that look binary are
  skipped; `crawl_project` reports them in `skippedFiles` with a reason.
- per-file parse failures never abort the crawl; they are reported in
  `parseErrors`.

Only the root `.gitignore` is read — nested `.gitignore` files are not yet
supported.

## Incremental crawls

A crawl records a manifest row per file (`size`, mtime, SHA-256, language). On the
next crawl a file whose size and truncated mtime both match is served from a cached
parse result instead of being re-read and re-parsed; a file whose mtime changed but
whose hash did not is also replayed from cache. Resolution, phantom-node creation and
derived edges still run over the whole in-memory file set, so cross-file edges stay
correct — only I/O, parsing and database writes are skipped.

`crawl_project` reports the split:

| Field | Meaning |
| --- | --- |
| `filesAdded` | First seen by this crawl |
| `filesUpdated` | Content changed, re-parsed |
| `filesUnchanged` | Replayed from the parse cache |
| `filesRemoved` | Disappeared from disk and were pruned |

**Known limitation:** because an unchanged file's edges are not rewritten, a call that
becomes *newly resolvable* only because some other file changed (for example a method
gained an overload, or a class was introduced that a previously-ambiguous call could
now bind to) will not be upgraded in the untouched file. Touch that file, or run
`clear_index`, to force full resolution.

## Benchmarks

`npm run bench` generates a synthetic TypeScript project (575 modules, ~137k lines,
~9.8k methods), crawls it, and reports crawl phases and query latency percentiles.
`tests/perf.test.ts` asserts the same budgets and is opt-in, because a realistic
corpus takes time to crawl:

```bash
npm run bench                                        # human-readable report
CODECRAWLER_BENCH=1 npm test -- tests/perf.test.ts   # enforce the budgets
CODECRAWLER_BENCH_LINES=20000 npm run bench          # smaller corpus
```

Measured on a Windows dev laptop with a warm disk cache; absolute numbers vary,
the *ratios* and the index usage are what matter:

| Phase | Duration | Added | Updated | Unchanged |
| --- | --- | --- | --- | --- |
| Cold crawl | 22.5 s | 575 | 0 | 0 |
| Re-crawl, nothing changed | 0.91 s | 0 | 0 | 575 |
| Re-crawl after a one-file edit | 0.75 s | 0 | 1 | 574 |

| Query | p50 | p95 | Budget (p95) |
| --- | --- | --- | --- |
| `search_symbols` (exact) | 0.69 ms | 1.96 ms | 50 ms |
| `search_symbols` (prefix) | 1.60 ms | 4.09 ms | 50 ms |
| `get_callers` (depth 2) | 0.16 ms | 0.21 ms | 50 ms |
| `get_callees` (depth 2) | 0.11 ms | 0.15 ms | 50 ms |
| `get_subgraph` (radius 2) | 0.16 ms | 0.27 ms | 50 ms |
| `find_entry_points` | 0.12 ms | 0.29 ms | 50 ms |
| `find_hotspots` | 145.5 ms | 181.4 ms | 1000 ms |
| `find_dead_code` | 99.8 ms | 290.3 ms | 1000 ms |

The index is 66 MB for those 14.4k nodes / 38.8k edges. `find_hotspots` and
`find_dead_code` are whole-project aggregations over every edge and node, which is why
their band is an order of magnitude looser than the symbol lookups; both were profiled
with `EXPLAIN QUERY PLAN` and are served by `idx_edges_target_kind`.

## CI & publishing

GitHub Actions runs on every pull request (`pull-request.yml`): `npm ci` →
typecheck → tests → build → smoke-test of the built CLI.

Merges to `main` trigger `publish.yml`, which re-runs the same checks and then,
if green, **auto-releases**:

1. Reads the most recent `v*` tag (or `package.json` version on the first run),
   computes the next patch version, and pushes a `vX.Y.Z` tag.
2. Creates a matching GitHub release.
3. Publishes the package to the npm registry with **provenance** (OIDC
   trusted publishing) — no token or repository secret is needed. The step is
   idempotent and retries: it skips versions npm already has, and a transient
   transparency-log or registry failure no longer aborts the release.
4. Publishes [`server.json`](server.json) to the
   [official MCP Registry](https://registry.modelcontextprotocol.io) as
   `io.github.nithin554/code-crawler` from a separate, re-runnable job using
   [`ExaDev/mcp-registry-publish`](https://github.com/ExaDev/mcp-registry-publish).
   The job runs inside the `mcp-registry-publish` environment, whose deployment
   branch policy is limited to `main`. It pins `server.json` to the release
   version, authenticates with GitHub OIDC, skips versions the registry already
   lists, and retries transient npm propagation or registry errors. Ownership is
   verified through the `mcpName` field in `package.json`.

## Using as an MCP server

### Install as an agent plugin

The repository is also an agent plugin, so Claude Code and Copilot CLI can install the
server and the skill together:

```bash
# Claude Code
/plugin marketplace add nithin554/code-crawler
/plugin install code-crawler@code-crawler

# Copilot CLI
copilot plugin marketplace add nithin554/code-crawler
copilot plugin install code-crawler@code-crawler
```

The plugin runs `npx -y @nithin554/code-crawler serve`. Agent Plugins clients start a
plugin's stdio servers inside the plugin directory, so the server does not treat that
directory as your checkout: it resolves a project from `crawl_project`, the client's
workspace roots, or the project this session already selected, and keeps that graph in
`<project>/.code-crawler/index.db` — one database per repository, the same layout the CLI
uses. `CODECRAWLER_DB` still pins a single file when you want one.

The same skill is published to [ClawHub](https://clawhub.ai) as `code-crawler`.

### One command

[`add-mcp`](https://github.com/neon-solutions/add-mcp) registers the server in whichever
client you name — Claude Code, Cursor, VS Code, Claude Desktop, Codex, OpenCode, Zed, and
more (`npx add-mcp list-agents`). Run it from inside the repository you want indexed:

```bash
npx add-mcp @nithin554/code-crawler --args serve -a cursor
```

That writes project-scoped config next to the code (`.mcp.json`, `.cursor/mcp.json`,
`.vscode/mcp.json`, …), so each repository carries its own registration and its own
`.code-crawler/index.db`. The server name `code-crawler` is derived from the package.

`--env CODECRAWLER_DB` is optional — add it only to put the database somewhere else:
`--env CODECRAWLER_DB=/absolute/path/to/index.db`. `-g` writes user-level config instead. Prefer that only for clients that launch the server
with your checkout as its working directory: with `-g` and an unrelated working directory
(Claude Desktop starts in its own install folder) the server falls back to
`~/.code-crawler/index.db`, and every repository then competes for that one file.

### One server per project

Outside plugin mode a server process opens one database at startup and a database holds
exactly one project, so the model is one registration per repository — which is what the
per-project config above gives you. The plugin install instead resolves a database per
project at call time, so one plugin serves every repository you open. Re-crawling a repository reuses its existing file and only re-parses what changed;
two repositories never share a file, so they cannot clash.

### MCP Registry / `npx`

The server is listed in the MCP Registry as `io.github.nithin554/code-crawler`.
Any `npx`-capable client can run it without a local checkout:

```json
{
  "mcpServers": {
    "code-crawler": {
      "command": "npx",
      "args": ["-y", "@nithin554/code-crawler", "serve"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "code-crawler": {
      "command": "node",
      "args": ["/absolute/path/to/code-crawler/dist/index.js", "serve"],
      "env": { "CODECRAWLER_DB": "/absolute/path/to/your/index.db" }
    }
  }
}
```

### Cursor / other stdio MCP clients

Point the client at the same command. The typical flow for an LLM agent:

1. `crawl_project` the repo once.
2. `find_entry_points` to see where execution actually starts (routes, listeners, mains).
3. `search_symbols` to locate the symbol of interest.
4. `get_callers` / `get_callees` / `trace_path` to reason about the call graph.
5. `trace_execution` to follow runtime dispatch and aspect advice; `find_aspects`,
   `get_decorators`, and `find_annotated` to inspect behaviour-changing annotations.
6. `find_routes`, `find_injections`, `find_reflections`, and `find_external_dependencies`
   to map framework wiring and third-party surface.

See [`USAGE.md`](USAGE.md) for the full task-oriented walkthrough.

## MCP surface

**Tools**

| Tool | Purpose |
| --- | --- |
| `crawl_project` | Index a directory (idempotent; one project per database) |
| `index_status` | Node/edge/file counts + last crawl |
| `search_symbols` | Fuzzy lookup by name or FQN, optional kind filter |
| `get_node` | Metadata + source location for one symbol |
| `get_callers` | Direct or transitive callers (depth-bounded) |
| `get_callees` | Direct or transitive callees (depth-bounded) |
| `trace_path` | Static call paths between two symbols (BFS, shortest first) |
| `trace_execution` | Dynamic trace: static calls + virtual dispatch + woven advice |
| `find_implementations` | Implementers/subclasses of an interface or superclass |
| `find_aspects` | Aspects, advice kinds, pointcuts, and intercepted methods |
| `get_decorators` | Annotations/decorators on a symbol and optionally its members |
| `find_annotated` | Every symbol annotated with a given annotation |
| `find_hotspots` | Rank methods by fan-in, fan-out, and advice interceptions |
| `find_dead_code` | Methods with no incoming call/dispatch/advice edges |
| `find_entry_points` | Framework-invoked roots: HTTP routes, listeners, schedulers, CLI mains, tests |
| `find_routes` | HTTP route → handler mappings (`@GetMapping`, NestJS, FastAPI, Express) |
| `find_injections` | DI-supplied dependencies (`@Autowired`, NestJS, FastAPI `Depends`) |
| `find_reflections` | Run-time lookups: `Class.forName`, `getattr`, `importlib`, dynamic `import()` |
| `find_external_dependencies` | Third-party packages with reference and file counts |
| `find_unresolved` | Call sites the resolver could not bind, grouped by failure reason |
| `impact_analysis` | Callers + entry points + routes + overrides + risk band in one call |
| `explain_symbol` | One-shot digest: members, decorators, callers, callees, wiring |
| `find_cycles` | Call cycles (SCCs) with a sample closed path, plus direct recursion |
| `export_graph` | Neighborhood rendered as Mermaid or Graphviz DOT |
| `get_subgraph` | Neighborhood extraction for visualization |
| `get_schema` | Describe the graph model |
| `clear_index` | Reset the database |

**Resources**: `codecrawler://schema`, `codecrawler://status`
**Prompt**: `trace-call-path(from, to)`

**Token budgeting.** The 18 list-returning query tools — every tool whose payload is a
single result list — accept `max_tokens` (100–200000) and `cursor`. Passing either adds a
`page` block with `totalCount`, `returnedCount`, `truncated`, `estimatedTokens`, and
`nextCursor`; omit both and the response shape is unchanged, so existing clients keep
working. Paging never returns an empty page while items remain, so a continuation loop
always terminates. Token counts are estimates from JSON length (~4 characters per token) —
no tokenizer dependency, deterministic across models.

`get_subgraph` is the one exception: its `nodes` and `edges` are two views of the same slice,
so cutting one list would leave edges pointing at omitted nodes. It is bounded by `radius` and
`limit` instead. Aggregate tools (`impact_analysis`, `explain_symbol`, `export_graph`) and
single-object tools (`get_node`, `index_status`, `get_schema`) return one object and take no
budget.

### Agent skill

The server tells an agent *what* it can call; the skill tells it *when*. `skills/code-crawler/`
ships in the npm package and is plain Markdown — `SKILL.md` for discovery and the
crawl-first workflow, `reference/tools.md` mapping all 27 tools to the questions they
answer, and `reference/edge-semantics.md` explaining `confidence`, `external`, and phantom
nodes.

```bash
npx skills add nithin554/code-crawler
```

The [skills CLI](https://skills.sh) finds it by convention and installs to whichever agents
you pick; `npx skills update` refreshes it. To install by hand instead, copy the directory
into your client's skills folder (`~/.claude/skills/code-crawler/`,
`.claude/skills/code-crawler/`, or a plugin's `skills/` root). No build step. See
[`USAGE.md`](USAGE.md#installing-the-agent-skill).

`tests/skill.test.ts` asserts the skill's tool table against the live registry, so it
cannot drift as tools are added.

## Graph model

**Nodes** — `kind` is one of `file | package | module | class | interface | enum | method |
constructor | field | import | external_symbol | aspect | annotation_type | annotation |
unknown_symbol`. Every node has a globally unique `qualifiedName` and a JSON `properties`
blob (signature, modifiers, lines, annotations, ...).

**Edges** — `kind` is one of `CALLS | DECLARED_IN | CONTAINS | IMPLEMENTS | EXTENDS |
IMPORTS | REFERENCES | DYNAMIC_DISPATCH | ADVISES | ANNOTATED_WITH | REFLECTS | INJECTS |
ROUTES`. `CALLS` edges carry `line`, `resolved`, `confidence`, and — when the call sits
behind control flow — `conditional`, `controlFlow`, and `guards`; `ANNOTATED_WITH` edges
carry `line` and `arguments`; `ADVISES` edges carry `adviceKind` and the resolved
`pointcut`; `INJECTS` carries `injectedName` and `framework`; `REFLECTS` carries
`mechanism`; `REFERENCES` carries `external`.

Id scheme:

| Symbol | Example |
| --- | --- |
| type | `com.acme.OrderService` |
| method | `com.acme.OrderService#place` |
| constructor | `com.acme.OrderService#<init>` |
| field | `com.acme.OrderService$repo` |
| annotation | `@Transactional` |
| import | `__import__:java.util.List` |
| unresolved call | `__unknown__:System.out.println` |
| Python/TS module | `module:app.service` |
| module-level function | `module:app.api#read_order` |
| module-level field | `module:app.service$AUDIT_LOG` |
| inline arrow handler | `module:src.routes#<anonymous@7>` |
| external package | `ext:fastapi` |
| reflective marker | `__reflect__:./plugins/${name}` |
| injection marker | `__inject__:Repo` |

## Dynamic behaviour

Static call edges answer *"what does the source literally call?"*. Runtime behaviour
differs in two ways, both modelled as derived edges rebuilt on every crawl:

### Virtual dispatch

A call to an interface or base-class method may execute any override. After all files
are indexed, every resolved `CALLS` edge whose target is an overridable method gets
`DYNAMIC_DISPATCH` edges to each override found in the project:

```text
Checkout#checkout --CALLS--> Payment#pay
Payment#pay --DYNAMIC_DISPATCH--> CardPayment#pay
Payment#pay --DYNAMIC_DISPATCH--> UpiPayment#pay
```

Constructors and `private`/`static`/`final` methods are excluded because they cannot be
overridden. Use `find_implementations` to list candidates and `trace_execution` to follow
them.

### Aspects, advice, and decorators

`@Aspect` types are indexed as `aspect` nodes. Advice methods are recognised by
`@Before`, `@After`, `@Around`, `@AfterReturning`, `@AfterThrowing`, and `@Pointcut`.
Named pointcuts (`@Around("paymentCall()")`) are resolved to their `@Pointcut`
expression, then matched against every project method to create `ADVISES` edges:

```text
AuditAspect#auditPayment --ADVISES--> Payment#pay
AuditAspect#auditPayment --ADVISES--> CardPayment#pay
AuditAspect#auditPayment --ADVISES--> UpiPayment#pay
AuditAspect#beforeCheckout --ADVISES--> Checkout#checkout
```

`trace_execution` weaves these in as `INTERCEPT` hops, so the trace reads:

```text
Checkout#checkout
  INTERCEPT  AuditAspect#beforeCheckout
  CALLS      Payment#pay
    INTERCEPT        AuditAspect#auditPayment
    DYNAMIC_DISPATCH CardPayment#pay -> authorize
    DYNAMIC_DISPATCH UpiPayment#pay   -> settle
```

Every other annotation is indexed as an `annotation` node with an `ANNOTATED_WITH` edge.
Framework decorators (`@Transactional`, `@Cacheable`, `@Async`, `@Retryable`,
`@PreAuthorize`, `@Scheduled`, ...) are additionally flagged `decorator: true` so
`get_decorators` and `find_annotated` can surface runtime-semantic annotations.

Python decorators and TypeScript decorators are modelled the same way: `@router.get(...)`,
`@injectable`, `@Controller(...)`, `@Get(':id')` and friends land in `annotations` on the
declaring type/method, and framework ones additionally produce routes, injections, or
entry-point marks.

### Reflection and run-time indirection

Lookups the compiler cannot see through are recorded as `REFLECTS` edges. When the target
is statically determinable — a string literal, a literal prefix plus a variable
(`importlib.import_module("app.plugins." + name)`), `getattr(obj, "run")`,
`require("./x")` — the edge points at the resolved symbol. Otherwise it points at a
`__reflect__:` marker carrying the `mechanism`:

```text
module:app.dynamic#load_plugin --REFLECTS--> __reflect__:app.plugins.   (importlib.import_module)
module:src.dynamic#loadPlugin   --REFLECTS--> __reflect__:./plugins/${name}   (import())
```

Dynamic module prefixes that belong to the project's own namespace stay in-project; only
genuinely foreign packages become external dependencies.

### Dependency injection

Dependencies the framework supplies are `INJECTS` edges instead of missing calls
(`find_injections`):

| Framework | Detected from |
| --- | --- |
| Spring | `@Autowired` fields/methods/constructors |
| NestJS | constructor parameters with decorators; `@Injectable()` classes |
| FastAPI | `Depends(...)` parameters |
| dependency-injector | constructor parameters of `@injectable` classes |
| plain TS/JS | constructor parameters typed with a project class |

Primitive and structural parameter types (`string`, `{ id: string }`, `list[str]`) are
counted but produce no edge, so `@Body() body: { id: string }` does not pollute the graph.

### Framework entry points and routes

Methods a framework invokes have no source-level caller, so marking them keeps dead-code
analysis honest and gives `trace_execution` a root (`find_entry_points`, `find_routes`):

| Language | Recognised |
| --- | --- |
| Java | `@GetMapping`, `@PostMapping`, `@RequestMapping`, `@Scheduled`, `@EventListener`, listener annotations, tests, `main` |
| Python | FastAPI (`@router.get`, `@app.post`), Flask (`@bp.route`), `if __name__ == "__main__"`, `pytest` tests |
| TypeScript | NestJS `@Controller` + `@Get`/`@Post`/... , Express `app.get('/x', handler)`, Jest tests |

Express handlers written inline get a synthetic method node
(`module:src.routes#<anonymous@7>`) so their body still gets call edges, containment, and
a route edge.

### Control flow on call edges

Each `CALLS` edge records whether it is guarded:

```json
{
  "kind": "CALLS",
  "source": "app.repository.OrderRepository#create",
  "target": "ext:builtins",
  "properties": { "line": 14, "conditional": true, "controlFlow": ["branch", "loop"],
                  "guards": ["row.get(\"id\") == order_id", "self.rows"] }
}
```

`controlFlow` uses `branch | loop | exception | predicate`. Guards are source text, not
symbolic constraints: they tell an agent *that* a call is conditional and *what* the
condition looked like, without pretending to model its truth value.

## Resolution heuristics

Java:

1. **Constructor calls** (`new Foo(...)`) → resolve `Foo` → `#<init>` (default ctor if implicit).
2. **Bare / `this.` / `super.` calls** → enclosing type + superclass chain.
3. **Type-qualified calls** (`com.acme.Foo.bar`) → resolve the type directly.
4. **Instance calls** (`x.method()`) → infer receiver type from locals → params → fields,
   then search that type and its ancestors.
5. **Otherwise** → phantom `unknown_symbol` node, `resolved:false`, with the inference
   failure reason attached to the edge.

Python and TypeScript add module-aware resolution on top of the same pipeline:

1. **Import-aware scope** — `from app.repository import OrderRepository` maps the local
   name to `app.repository.OrderRepository`; relative and project modules are resolved by
   suffix, bare specifiers fall back to package roots.
2. **`self.x` / `this.x`** resolve against the enclosing class's fields; a receiver that
   starts with `self`/`this`/`cls`/`super` never becomes an external package.
3. **Dotted receivers** (`service.repo.find`) are walked segment by segment: the first
   segment resolves to a type, the next to a field on it, and container members such as
   `list.append` are recognised as builtin rather than unknown.
4. **Locals** are typed from parameters, annotated assignments, `new T()`, and inferred
   loop/variable element types (`for row in self.rows:` → `row: dict`).
5. **Module functions** (`module:app.api#read_order`) participate in dispatch, routes, and
   entry-point marking exactly like class methods.

Each resolved edge carries a `confidence` score and a human-readable `reason` trace
(e.g. `via local orders: OrderService`), so LLM clients can weigh how much to trust it.

## Implemented languages

| Language | Extensions | Extracted | Dynamic features |
| --- | --- | --- | --- |
| Java | `.java` | packages, classes, interfaces, enums, annotations, constructors, methods, fields | virtual dispatch, AspectJ/Spring AOP advice, `@Autowired`, `@RequestMapping` family, `Class.forName`, `ServiceLoader` |
| Python | `.py`, `.pyi` | modules, classes, functions, methods, fields, decorators | `@injectable`/`Depends` injection, FastAPI/Flask routes, `getattr`, `importlib`, `__main__`, tests |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | modules, classes, interfaces, type aliases, enums, methods, fields, arrow functions | NestJS/Angular decorators, DI constructor injection, NestJS/Express routes, `import()`, `require()` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | modules, classes, functions, fields | decorators, Express routes, `require()` |

Crawling a directory mixes all of them automatically — language is chosen per file from
the extension, and a single crawl can return `languages: ["java", "python", "typescript"]`.

Adding a language requires:

1. `src/parser/languages/<lang>.ts` — a `LanguageDescriptor` implementing `parseFile`
   (module/package extraction, type/member extraction, raw call sites, local type tables)
   plus three declarative fields: `resolver` (which call resolver handles it),
   `frameworks` (what its parser recognises), and `fixture` (its conformance directory).
2. One row in `src/parser/languages/index.ts`.
3. One row in the `CONTRACTS` table in `tests/language-conformance.test.ts` — the suite
   then holds the new language to the same graph invariants as every other one.
4. Optionally a resolver in `src/resolver/` exposed through `src/resolver/registry.ts`;
   most languages work with the shared `module` resolver and only override
   language-specific builtins.
5. Any framework it should recognise that is not registered yet — a module in
   `src/parser/frameworks/` declaring its entry points, injections and markers. That is
   a data change: no parser is edited.

Frameworks are resolved per file by import evidence, then by the descriptor's
`frameworks` order, then by every registered module. A file that imports
`dependency_injector` attributes its `@inject` there, while a Java file with no such
import still falls back to the registry rather than losing the annotation. Parsers keep
what is genuinely syntactic: receiver names for call-style routes, path joining, and the
text recorded as an entry point's detail.

No existing language module needs editing: dispatch in `src/crawler.ts` reads the
descriptor's `resolver`, so a language never appears in a conditional.

The graph schema, store, traversal queries, and MCP surface stay the same for every
language. Candidate next languages, and the modelling each one needs, are ranked in
[`ROADMAP.md`](ROADMAP.md) Phase 3.

## What is not modelled

Language-specific gaps, in addition to the shared ones below:

| Language | Not modelled |
| --- | --- |
| `java` | A `record` is indexed as a `class` with `record: true`; components become `private final` fields plus a synthesized accessor each, but the implicit canonical constructor gets no signature until a call resolves to it. Lambda bodies are indexed, but a method reference such as `this::handle` has no static target and produces no call edge. `static {}` and instance initialiser blocks are not extracted. Generic type parameters are erased, so a call through a `List<T>` field binds to the declared bound rather than the concrete argument. |
| `python` | No metaclass, descriptor, `__getattr__`, or `__getattribute__` modelling. Members a decorator generates rather than writes — `@dataclass`'s `__init__` and `__eq__`, anything a metaclass adds — have no declaration to point at, so calls to them stay unresolved. Monkey-patching at import time is not tracked. A `lambda` stored on an attribute and invoked later has no target. |
| `typescript` | A `namespace X {}` block produces no module node, so members declared inside one are not reachable by name. JSX parses cleanly but the element tree is not modelled. Type-level constructs — conditional, mapped, template-literal, intersection — are not evaluated, so a receiver typed that way falls back to unresolved. `static {}` blocks and `accessor` fields are not extracted. |
| `javascript` | Handled by the TypeScript parser, so every gap above applies. With no annotations available, receivers come only from `new`, assigned initialisers, and the language-agnostic heuristics — dynamically typed code resolves less often than annotated code does. |

Not yet modelled, by design:

- Value flow and branch feasibility — edges say *that* a call is conditional and record
  the guard text, not which branch is taken.
- Cross-repository resolution — libraries outside the crawled tree are summarised as
  `ext:` packages rather than crawled.
- Fully dynamic targets (`getattr(obj, name)`, `require(userInput)`) point at a
  `__reflect__:` marker instead of a symbol; there is nothing static to point at.
- Runtime DI graphs assembled from configuration files rather than code.
- Receiver inference from an expression rather than a name — `getService().run()`,
  `items[0].run()`, a ternary, or a cast — so those calls report as unresolved.
- Overload selection uses argument count first, then the type of each argument where
  the call site states one (literals, `new` expressions, casts). Two overloads that a
  call cannot distinguish — `f(count)` against `f(int)` and `f(String)` — still bind to
  the first declaration in source order. Overloaded declarations keep distinct ids
  (`Type#f`, `Type#f(int)`, `Type#<init>(String)`) after the first one; see
  [`USAGE.md`](USAGE.md#7-what-is-and-is-not-modelled) for the id scheme.

The full list, and what is modelled in exchange for each gap, is in
[`USAGE.md`](USAGE.md#7-what-is-and-is-not-modelled).

## Architecture

```
src/
├── index.ts                    CLI (crawl | status | query | serve)
├── server.ts                   MCP server: tools, resources, prompt (thin handlers)
├── crawler.ts                  file discovery → parse → index → resolve → persist
├── config.ts                   env-overridable configuration
├── graph/
│   ├── schema.ts               node/edge kinds, id scheme, property shapes
│   ├── store.ts                better-sqlite3 schema + idempotent file-scoped upserts
│   └── queries.ts              recursive-CTE traversal (callers/callees/path/subgraph)
├── parser/
│   ├── language.ts             LanguageConfig / LanguageDescriptor contracts
│   ├── treeSitter.ts           WASM runtime + grammar loading + CST walk helpers
│   ├── controlFlow.ts          enclosing branch/loop/try/catch + guard text
│   ├── moduleId.ts             import-aware module id derivation
│   ├── methodId.ts             method id scheme (overload signatures, constructor ids)
│   ├── frameworks/
│   │   ├── types.ts            FrameworkModule / FrameworkScope contracts
│   │   ├── index.ts            registry + scope/entry-point/injection lookups
│   │   └── <framework>.ts      one module per framework (spring, nestjs, fastapi, …)
│   └── languages/
│       ├── index.ts            descriptor table + per-file language detection
│       ├── java.ts             Java structural extraction
│       ├── python.ts           Python structural extraction
│       └── typescript.ts       TypeScript, TSX and JavaScript extraction
└── resolver/
    ├── types.ts                TypeIndex (global name/method index) + Resolver contract
    ├── registry.ts             resolver lookup, capability query, default fallback
    ├── common.ts               builtin types, external packages, receiver inference
    ├── dynamic.ts              virtual dispatch + AspectJ pointcut matching/advice edges
    ├── genericResolver.ts      the `module` resolver (imports, barrels, overloads)
    └── javaResolver.ts         the `java` resolver (declared types, hierarchy, overloads)
```

## Roadmap

Language-agnostic architecture, more languages, and better resolution are tracked in
[`ROADMAP.md`](ROADMAP.md). The near-term focus is making a new language a one-module
change, then using that to add Go, C#, and Kotlin.

## Documentation site

The static documentation site in `docs/` is deployed to GitHub Pages by
`.github/workflows/pages.yml`. It covers quickstart, the MCP tool reference, and worked
examples. Open `docs/index.html` locally or visit
<https://nithin554.github.io/code-crawler/>.

## License

MIT
