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
- **Idempotent, file-scoped indexing** — re-crawling refreshes changed files, rebuilds
  derived dynamic edges, and removes stale ones without duplicating the graph.
- **Analytics** — hotspots (fan-in/fan-out/advice counts) and dead-code candidates.
- **Self-contained**: single SQLite file, no external services.
- **LLM-friendly**: every tool returns structured JSON, unknown symbols come back with
  fuzzy search suggestions.

## Install & build

Requires Node.js ≥ 20.

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest (125 tests)
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
| `CODECRAWLER_HELPFUL_ERRORS` | `true` | Fuzzy suggestions on symbol misses |

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
| `crawl_project` | Index a directory (idempotent) |
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
| `get_subgraph` | Neighborhood extraction for visualization |
| `get_schema` | Describe the graph model |
| `clear_index` | Reset the database |

**Resources**: `codecrawler://schema`, `codecrawler://status`
**Prompt**: `trace-call-path(from, to)`

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
| Java | `.java` | packages, classes, interfaces, enums, records, annotations, constructors, methods, fields | virtual dispatch, AspectJ/Spring AOP advice, `@Autowired`, `@RequestMapping` family, `Class.forName`, `ServiceLoader` |
| Python | `.py` | modules, classes, functions, methods, fields, decorators | `@injectable`/`Depends` injection, FastAPI/Flask routes, `getattr`, `importlib`, `__main__`, tests |
| TypeScript | `.ts`, `.tsx` | modules, classes, interfaces, type aliases, enums, methods, fields, arrow functions | NestJS/Angular decorators, DI constructor injection, NestJS/Express routes, `import()`, `require()` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | modules, classes, functions, fields | decorators, Express routes, `require()` |

Crawling a directory mixes all of them automatically — language is chosen per file from
the extension, and a single crawl can return `languages: ["java", "python", "typescript"]`.

Adding a language requires:

1. `src/parser/languages/<lang>.ts` — a `LanguageConfig` implementing `parseFile`
   (module/package extraction, type/member extraction, raw call sites, local type tables).
2. Register it in `src/parser/languages/index.ts`.
3. Optionally a `src/resolver/<lang>Resolver.ts`; most languages work with the shared
   `src/resolver/genericResolver.ts` and only override language-specific builtins.

The graph schema, store, traversal queries, and MCP surface stay the same for every
language. Candidate next languages, and the modelling each one needs, are ranked in
[`ROADMAP.md`](ROADMAP.md) Phase 3.

Not yet modelled, by design:

- Value flow and branch feasibility — edges say *that* a call is conditional and record
  the guard text, not which branch is taken.
- Cross-repository resolution — libraries outside the crawled tree are summarised as
  `ext:` packages rather than crawled.
- Fully dynamic targets (`getattr(obj, name)`, `require(userInput)`) point at a
  `__reflect__:` marker instead of a symbol; there is nothing static to point at.
- Runtime DI graphs assembled from configuration files rather than code.

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
│   ├── language.ts             LanguageConfig contract
│   ├── treeSitter.ts           WASM runtime + grammar loading + CST walk helpers
│   ├── controlFlow.ts          enclosing branch/loop/try/catch + guard text
│   ├── moduleId.ts             import-aware module id derivation
│   └── languages/
│       ├── index.ts            language registry + per-file language detection
│       ├── java.ts             Java structural extraction
│       ├── python.ts           Python structural extraction
│       └── typescript.ts       TypeScript, TSX and JavaScript extraction
└── resolver/
    ├── types.ts                TypeIndex (global name/method index) + ResolvedCall
    ├── common.ts               builtin types, external packages, receiver inference
    ├── dynamic.ts              virtual dispatch + AspectJ pointcut matching/advice edges
    ├── genericResolver.ts      shared resolution for module-based languages
    └── javaResolver.ts         Java call-target resolution heuristics
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
