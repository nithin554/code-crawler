# Tool reference

All 27 tools, grouped by the question they answer. Run `index_status` before trusting any
result, and `crawl_project` before that if the index is empty.

## Orientation

Call these to establish what the index contains, not to answer questions about code.

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `crawl_project` | The index is empty, or files changed on disk | `path` (root), `force` |
| `index_status` | Before every session, and before believing a negative result | none |
| `get_schema` | You need the node/edge vocabulary or property names | none |
| `clear_index` | A crawl was rooted at the wrong directory and the graph is unusable | none |

`crawl_project` is incremental by default. Pass `force: true` only after a history rewrite,
branch switch, or stash pop - see [edge-semantics.md](edge-semantics.md) for why.

## Find a symbol

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `search_symbols` | You have a name fragment but not a node id | `query`, `kind` |
| `get_node` | You have a node id and want its metadata and source location | `id` |
| `explain_symbol` | You want one digest instead of four separate calls | `id` or `name` |

`explain_symbol` returns members, decorators, callers, callees, and framework wiring in one
payload. Reach for it first when exploring an unfamiliar symbol; drop to `get_callers` or
`get_callees` when you need the full list rather than a summary.

## Relationships

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `get_callers` | "Who calls this?" - direct or transitive | `id`, `depth` |
| `get_callees` | "What does this call?" - direct or transitive | `id`, `depth` |
| `trace_path` | "How does execution get from A to B?" | `from`, `to` |
| `trace_execution` | You need dynamic dispatch and woven advice, not just static calls | `id` |
| `get_subgraph` | You want the neighbourhood as data for a diagram | `id`, `radius`, `limit` |
| `export_graph` | You want Mermaid or Graphviz text you can paste | `id`, `format` |

`get_callers`/`get_callees` take `depth` - keep it at 1 unless the question is explicitly
transitive, because depth 3 on a hub method returns most of the repository.

`get_subgraph` is bounded by `radius`/`limit` rather than `max_tokens`, because its `nodes`
and `edges` are two views of one slice and cutting one list leaves dangling references.

## Impact and risk

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `impact_analysis` | "What breaks if I change this?" - the one call to prefer | `id` |
| `find_implementations` | You have an interface and need its implementers | `id` |
| `find_cycles` | You suspect mutual recursion or a dependency knot | none |
| `find_dead_code` | You want methods with no incoming edges at all | none |
| `find_hotspots` | You want the highest fan-in/fan-out methods ranked | `limit` |

`impact_analysis` bundles callers, entry points, routes, overrides, and a risk band. Prefer
it over assembling the same answer from four calls.

`find_dead_code` reports *no incoming call, dispatch, or advice edge*. Treat that as a
candidate list: a method invoked purely by reflection or by an external framework will
appear here. Cross-check with `find_reflections` and `find_entry_points` before deleting
anything.

## Framework wiring

These tools exist because the call graph alone cannot see how a framework invokes code.

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `find_entry_points` | "Where does this system begin?" | `kind` |
| `find_routes` | You want HTTP route to handler mappings | `framework` |
| `find_injections` | You want DI-supplied dependencies | `framework` |
| `find_annotated` | You want every symbol carrying one annotation | `annotation` |
| `get_decorators` | You want the decorators on one symbol | `id`, `includeMembers` |
| `find_aspects` | You want aspects, advice kinds, and intercepted methods | none |
| `find_reflections` | You want runtime lookups (`Class.forName`, `getattr`, `import()`) | none |

Entry-point kinds include HTTP routes, listeners, schedulers, CLI mains, and tests. If a
method looks dead but is plausibly framework-invoked, check `find_entry_points` and
`find_reflections` before concluding it is unreachable.

## Coverage and dependencies

| Tool | Use it when | Key argument |
| --- | --- | --- |
| `find_unresolved` | You need to know how much of the graph failed to bind | none |
| `find_external_dependencies` | You want the third-party packages actually referenced | none |

`find_unresolved` is grouped by failure reason, which is the useful part: a cluster of one
reason usually means one modelling gap, not many broken call sites.

`find_external_dependencies` lists packages with reference and file counts. Use it to answer
"do we actually use this dependency?" - an empty result for a package in `package.json` means
nothing in the indexed code references it.

## Budgeting

Every list-returning tool accepts `max_tokens` and `cursor`; passing either adds a `page`
block with `totalCount`, `returnedCount`, `truncated`, `estimatedTokens`, and `nextCursor`.
Omit both and the response shape is unchanged.

Aggregate tools (`impact_analysis`, `explain_symbol`, `export_graph`) and single-object
tools (`get_node`, `index_status`, `get_schema`) return one object and take no budget.

Use `totalCount` from the first page instead of paging to count.
