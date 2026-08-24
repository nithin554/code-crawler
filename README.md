# Code-Crawler

**Static call tracing MCP server backed by a persistent property graph of your codebase.**

Code-Crawler indexes a project into a SQLite-backed property graph — files, packages,
classes, methods, fields, imports, and **call edges** — then exposes that graph to LLM
clients as MCP tools: find callers, trace call paths, explore neighborhoods, and search
symbols across the whole codebase.

```
        ┌───────────────────────  MCP (stdio)  ───────────────────────┐
        │  crawl_project  search_symbols  get_callers  get_callees     │
        │  trace_path     get_subgraph   get_node      get_schema ...  │
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
and answers them instantly with bounded recursive SQL queries.

## Features

- **Java-first** via the `tree-sitter-java` grammar (WASM — no native build step).
  The parser/resolver layer is designed so more languages plug in per-language config modules.
- **Call resolution heuristics** that go beyond naive string matching:
  receiver types inferred from locals, parameters, fields, `new T()` expressions,
  bare/`this`/`super` calls, static/qualified calls, and superclass chains.
  Unresolvable calls become `unknown_symbol` phantom nodes with `resolved:false` edges,
  so the graph stays traversable.
- **Idempotent, file-scoped indexing** — re-crawling refreshes changed files and removes
  stale ones without duplicating the graph.
- **Self-contained**: single SQLite file, no external services.
- **LLM-friendly**: every tool returns structured JSON, unknown symbols come back with
  fuzzy search suggestions.

## Install & build

Requires Node.js ≥ 20.

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest (53 tests)
```

## CLI

```bash
codecrawler crawl <path>     # index a project
codecrawler status           # index summary
codecrawler query <symbol>   # fuzzy-lookup a symbol
codecrawler serve            # start the MCP server over stdio (default)
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODECRAWLER_DB` | `~/.code-crawler/index.db` | Database path |
| `CODECRAWLER_EXCLUDE_DIRS` | `.git,node_modules,dist,build,target,...` | Dirs skipped during crawl |
| `CODECRAWLER_DEFAULT_LIMIT` | `50` | Default result cap |
| `CODECRAWLER_MAX_DEPTH` | `10` | Traversal depth cap |

## CI & publishing

GitHub Actions runs on every pull request (`pull-request.yml`): `npm ci` →
typecheck → tests → build → smoke-test of the built CLI.

Merges to `main` trigger `publish.yml`, which re-runs the same checks and then,
if green, **auto-releases**:

1. Reads the most recent `v*` tag (or `package.json` version on the first run),
   computes the next patch version, and pushes a `vX.Y.Z` tag.
2. Creates a matching GitHub release.
3. Publishes the package to the npm registry with **provenance** (OIDC
   trusted publishing) — no token or repository secret is needed.

To enable npm publishing, enable **Trusted Publishing** for the package on
npmjs.com (npmjs.com/settings → Packages → your package → "Trusted Publishing"),
pointing at this repository and the `npmjs-publish` environment. Optionally add
approval rules to that environment to gate releases.

## Using as an MCP server

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
2. `search_symbols` to locate the symbol of interest.
3. `get_callers` / `get_callees` / `trace_path` to reason about the call graph.

## MCP surface

**Tools**

| Tool | Purpose |
| --- | --- |
| `crawl_project` | Index a directory (idempotent) |
| `index_status` | Node/edge/file counts + last crawl |
| `search_symbols` | Fuzzy lookup by name or FQN, optional kind filter |
| `get_node` | Metadata + source location for one symbol |
| `get_callers` | Direct or transitive callers (depth-bounded) |
| `get_callees` | Direct or transitive callees (depth-bounded) |
| `trace_path` | Static call paths between two symbols (BFS, shortest first) |
| `get_subgraph` | Neighborhood extraction for visualization |
| `get_schema` | Describe the graph model |
| `clear_index` | Reset the database |

**Resources**: `codecrawler://schema`, `codecrawler://status`
**Prompt**: `trace-call-path(from, to)`

## Graph model

**Nodes** — `kind` is one of `file | package | class | interface | enum | method |
constructor | field | import | unknown_symbol`. Every node has a globally unique
`qualifiedName` and a JSON `properties` blob (signature, modifiers, lines, ...).

**Edges** — `kind` is one of `CALLS | DECLARED_IN | CONTAINS | IMPLEMENTS | EXTENDS |
IMPORTS | REFERENCES`. `CALLS` edges carry `line`, `resolved`, and `confidence`.

Id scheme:

| Symbol | Example |
| --- | --- |
| type | `com.acme.OrderService` |
| method | `com.acme.OrderService#place` |
| constructor | `com.acme.OrderService#<init>` |
| field | `com.acme.OrderService$repo` |
| import | `__import__:java.util.List` |
| unresolved call | `__unknown__:System.out.println` |

## Java resolution heuristics

1. **Constructor calls** (`new Foo(...)`) → resolve `Foo` → `#<init>` (default ctor if implicit).
2. **Bare / `this.` / `super.` calls** → enclosing type + superclass chain.
3. **Type-qualified calls** (`com.acme.Foo.bar`) → resolve the type directly.
4. **Instance calls** (`x.method()`) → infer receiver type from locals → params → fields,
   then search that type and its ancestors.
5. **Otherwise** → phantom `unknown_symbol` node, `resolved:false`, with the inference
   failure reason attached to the edge.

Each resolved edge carries a `confidence` score and a human-readable `reason` trace
(e.g. `via local orders: OrderService`), so LLM clients can weigh how much to trust it.

## Roadmap: multi-language

The parsing layer is language-agnostic. Adding a language requires:

1. `src/parser/languages/<lang>.ts` — a `LanguageConfig` implementing `parseFile`
   (package/module extraction, type/member extraction, raw call sites, local type tables).
2. Register it in `src/parser/languages/index.ts`.
3. `src/resolver/<lang>Resolver.ts` — translate raw call sites into resolved targets
   using the shared `TypeIndex`.

Natural next targets: **Python** (native AST or tree-sitter-python), **TypeScript/JavaScript**
(tree-sitter-typescript), and **Go** (tree-sitter-go). The graph schema, store, traversal
queries, and MCP surface all stay the same.

Planned enhancements:

- Package-level dependency graphs (module boundaries, cycle detection).
- Global call-graph analytics: hotspots (most-called methods), dead-code candidates
  (methods with no incoming CALLS edges), fan-in/fan-out metrics.
- Test coverage mapping (which tests exercise a given symbol).
- Incremental crawling (watch mode) and git-blame aware invalidation.

## Architecture

```
src/
├── index.ts            CLI (crawl | status | query | serve)
├── server.ts           MCP server: tools, resources, prompt (thin handlers)
├── crawler.ts          file discovery → parse → index → resolve → persist
├── config.ts           env-overridable configuration
├── graph/
│   ├── schema.ts       node/edge kinds, id scheme, property shapes
│   ├── store.ts        better-sqlite3 schema + idempotent file-scoped upserts
│   └── queries.ts      recursive-CTE traversal (callers/callees/path/subgraph)
├── parser/
│   ├── language.ts     LanguageConfig contract
│   ├── treeSitter.ts   WASM runtime + grammar loading + CST walk helpers
│   └── languages/
│       ├── index.ts    language registry
│       └── java.ts     Java structural extraction
└── resolver/
    ├── types.ts        TypeIndex (global name/method index) + ResolvedCall
    └── javaResolver.ts Java call-target resolution heuristics
```

## License

MIT
