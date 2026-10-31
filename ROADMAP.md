# Roadmap

> **Status:** planning document. Nothing here is committed work; ordering and scope will
> change as the crawler is used on real repositories.
>
> **Guiding principle:** the crawler is not a compiler. It should stay fast, explainable,
> and explicit about what it does not know. When a question needs full semantic analysis,
> the honest answer is a confidence score and a reason — not a guess.

---

## Current baseline

| Area | Today |
|---|---|
| Languages | Java, Python, TypeScript, JavaScript |
| Parsing | `LanguageDescriptor` per language: extensions → grammar → resolver → frameworks → fixture |
| Resolution | One `Resolver` contract, two implementations: `java` (declared types + hierarchy) and `module` (imports and barrels) |
| Graph | SQLite property graph: 15 node kinds, 13 edge kinds, WAL |
| Tools | 27 MCP tools |
| Tests | 32 test files, per-language fixtures, conformance matrix + migration + index-plan + scale checks |
| Quality gates | Biome lint/format, coverage thresholds, Node 22/24 matrix |

The biggest structural gap is the **per-language entry cost**: a new language needs a
`LanguageConfig`, a resolver, framework knowledge inside its parser, and a conformance
row. Phase 0 shrank that to data.

---

## Phase 0 — Make language #5 cheap

*Goal: a new language is one config module, one resolver module, one fixture directory.*

| Item | Change | Effort | Status |
|---|---|---|---|
| 0.1 | Collapse `javaResolver.ts` and `genericResolver.ts` behind one `Resolver` interface with declared capabilities | M | **done** — `Resolver` in `resolver/types.ts`, looked up through `resolver/registry.ts`; `crawler.ts` no longer branches on language |
| 0.2 | Move framework detection out of parsers into `src/parser/frameworks/<framework>.ts`, keyed by import evidence | M | **done** — one module per framework in `parser/frameworks/`, resolved through `frameworks/index.ts`; a file's imports pick the evidence, its descriptor settles ties. Parsers keep only syntax: receiver heuristics, path joining and entry-point detail text |
| 0.3 | One language descriptor: extensions → grammar → resolver → frameworks → fixture path | S | **done** — `LanguageDescriptor` in `parser/language.ts`, declared beside each parser |
| 0.4 | Conformance suite every language must pass (types, calls, imports, one route, one reflection) | S | **done** — `tests/language-conformance.test.ts`, now also asserting it covers exactly the registered languages |
| 0.5 | `.crawlerrc.json` — include/exclude globs, language overrides, module roots, tsconfig paths, Python package roots | S | **done** — discovery globs and language overrides ship in `loadCrawlerRc`; `moduleRoots` shortens module ids for source roots, and `tsconfig`/`jsconfig` `paths` + `baseUrl` are read in `parser/tsPaths.ts`. Both feed a `crawl_meta` fingerprint, so changing either re-parses cached files |

**Exit criteria:** a new language needs no edits to existing language modules, and CI
fails if the conformance suite regresses. *Both now hold: dispatch reads the
descriptor, the conformance suite fails if a registered language has no contract
row or points at a missing fixture, and a new framework is a module in
`parser/frameworks/` rather than an edit to each parser that can host it.*

## Phase 1 — Resolution quality

Highest value per hour of work; every unresolved edge today is a question an agent
cannot answer.

- **Monorepo roots.** `tsconfig` `paths`/`baseUrl`, `package.json` workspaces,
  `pyproject.toml` / `setup.cfg`, Maven and Gradle module boundaries.
- **Python.** Relative-import depth, `__init__.py` re-exports (`__all__`), star imports,
  `conftest.py`, `functools.wraps` signature preservation.
- **TypeScript/JavaScript.** Barrel files, `export default`, type-only imports, generics
  on receivers, `satisfies`, React components (JSX return → component) and hooks.
- **Python route attribution.** `framework` on a `ROUTES` edge currently reports the
  decorator receiver (`router`), not the library. Attribute `fastapi` / `flask` /
  `quart` from imported symbols so route reports group by framework.
- **Visible failures.** Aggregate resolver `reason` values into a `find_unresolved` tool
  and surface them in `get_node`. Unresolved edges are acceptable; unexplained ones are not.
- **Optional compiler-assisted mode.** A `tsc` program or `jdtls` bridge behind a flag for
  teams that prefer precision over setup cost.

## Phase 2 — Graph completeness and the polyglot payoff

- **First-class `route` nodes.** Routes are currently properties on `ROUTES` edges, so
  "who calls `GET /orders/{id}`" cannot be asked. Route nodes make them traversable.
- **Cross-language edges.** `fetch("/api/orders")` in TypeScript → route node → Spring or
  FastAPI handler. This is the capability no single-language indexer offers.
- **New edges.** `INSTANTIATES`, `OVERRIDES`, `EXPORTS`, `RETURNS`, `THROWS`,
  `READS` / `WRITES` (field access, enabling data-dependency queries), `CALLS_HTTP`.
- **New node kinds.** `function`, `variable`, `namespace`, `struct`, `trait` — the last two
  are prerequisites for Go, Rust, and C#.

## Phase 3 — Language rollout

Ordered by value ÷ modelling cost.

| Language | Grammar | New modelling required | Frameworks | Effort |
|---|---|---|---|---|
| **Go** | `tree-sitter-go` | structs, implicit interface satisfaction (dispatch fan-out), `panic`/`recover` | `gin`, `echo`, `chi`, `net/http`, `wire`, `fx` | S–M |
| **C#** | `tree-sitter-c-sharp` | attributes, properties, generics — close to Java, reuses Phase 0.1 | ASP.NET Core attribute routing, `[FromServices]`, MediatR | M |
| **Kotlin** | `tree-sitter-kotlin` | top-level and extension functions, data classes, coroutines | Spring, Ktor | M |
| **Ruby** | `tree-sitter-ruby` | `method_missing`, `send`, `require`, open classes — reflection is the default | Rails routes, ActiveRecord, `Concern` | M–L |
| **Rust** | `tree-sitter-rust` | traits and `impl` blocks, modules, best-effort macro handling | axum, actix | L |
| **PHP** | `tree-sitter-php` | traits, namespaces, magic methods | Laravel container and facades, Symfony | M–L |
| Swift / C / C++ | not yet scoped | not yet scoped | Vapor (Swift only) | L–XL |

Two rules for every language added:

1. It ships with a fixture project and conformance tests in the same pull request.
2. It documents what it does **not** model, in `README.md` and `USAGE.md`.

### Non-code surfaces (higher value than a ninth language)

Each of these fits the `LanguageDescriptor` shape and produces far more insight per line than
another general-purpose language:

- **SQL** — tables, columns, and queries as nodes and edges, so `get_callers` works on a
  table and schema changes become impact analysis.
- **OpenAPI / protobuf** — contracts as nodes, enabling cross-service `CALLS_HTTP` edges.
- **Docker / compose** — deployment topology as a second graph layer.

## Phase 4 — Scale

- ✅ **Incremental indexing.** Per-file manifest (size, mtime, SHA-256) plus a cache of the
  serialised parse result; unchanged files are replayed instead of re-read and re-parsed.
  `crawl_project` reports `filesAdded` / `filesUpdated` / `filesUnchanged` / `filesRemoved`.
- ✅ **Benchmark fixture.** `bench/` generates a ~137k-line project; `npm run bench` reports
  crawl phases and query percentiles, and `tests/perf.test.ts` enforces the budgets
  (measured: 22.5 s cold, 0.9 s no-op re-crawl, 0.75 s after a one-file edit).
- **Parallel parsing** with worker threads; batched transactions (WAL and core indexes
  already exist in `store.ts`).
- **Budget caps and progress** for very large repositories; a `code-crawler watch` mode.
  Progress notifications exist; the worker pool is still deferred because tree-sitter WASM
  grammars/parsers are cached module state.
- **Nested `.gitignore` support** — only the root file is read today.

## Phase 5 — Agent ergonomics

- ✅ **`search_symbols` on SQLite FTS5.** External-content FTS5 index with BM25 ranking and
  exact/prefix boosting, falling back to a `LIKE` scan only when FTS returns nothing. The
  optional semantic tier is still open.
- **New tools.** `find_unresolved`, `explain_symbol` (one-shot context bundle),
  `diff_graph`, `impact_analysis`, `find_cycles`, `export_graph` (Mermaid, DOT, GraphML).
- **Token budgets.** A `max_tokens` option on list-returning tools — MCP clients are
  context-limited, and 50 verbose nodes can consume a turn.
- **MCP resources and prompts** so the graph is addressable as context, not only through
  tool calls.

## Phase 6 — Quality and release

- Golden snapshot tests of graph output per language.
- A conformance gate in GitHub Actions.
- `npm publish` with provenance.
- Docs updated in the same pull request as each phase — the `USAGE.md` + docs-site
  pattern already used for releases.

---

## Sequencing

```mermaid
flowchart LR
  P0["Phase 0<br/>architecture"] --> P1["Phase 1<br/>resolution"]
  P0 --> P3["Phase 3<br/>languages"]
  P1 --> P2["Phase 2<br/>graph + cross-language"]
  P2 --> P5["Phase 5<br/>agent tools"]
  P3 --> P4["Phase 4<br/>scale"]
  P1 --> P6["Phase 6<br/>quality"]
```

Effort key: **S** ≤ 1 day · **M** 1–3 days · **L** 1–2 weeks · **XL** > 2 weeks.

## Non-goals

These are deliberate exclusions, not backlog items:

- Value flow, points-to analysis, and branch feasibility.
- Symbolic execution or anything requiring a full type checker in the default path.
- Runtime instrumentation or execution tracing of a live process.
- Crawling third-party dependencies. External code stays an `ext:` summary.
- Cross-repository resolution beyond explicit service contracts (Phase 2).
