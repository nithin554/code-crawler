# Edge semantics

Three things cause most misreads of this graph: `confidence`, `external`, and phantom
nodes. Read this before reporting "no callers", "dead code", or "unresolved".

## Edge kinds

| Kind | Means |
| --- | --- |
| `CALLS` | A statically resolved call |
| `DYNAMIC_DISPATCH` | A call that reaches an implementation through an interface or superclass |
| `ADVISES` | Around/before/after advice intercepting a method |
| `DECLARED_IN` | Symbol to its containing type |
| `CONTAINS` | Type to its members, module to its declarations |
| `IMPLEMENTS` | Type to the interface it implements |
| `EXTENDS` | Type to its superclass |
| `IMPORTS` | File to the module it imports |
| `ANNOTATED_WITH` | Symbol to an annotation or decorator |
| `REFERENCES` | A non-call reference, such as a field or type use |
| `REFLECTS` | A runtime lookup that may reach a symbol |
| `INJECTS` | A DI-supplied dependency |
| `ROUTES` | An HTTP route to its handler |

A method reached only by `DYNAMIC_DISPATCH`, `ADVISES`, or `ROUTES` **is still called**.
When asking "who calls this", look at all inbound edge kinds, not just `CALLS`.

## `confidence` is a band, not a probability

Do not average it, threshold it, or present it as certainty. It is a coarse label telling
you *what kind of evidence* produced the edge.

| Value | Evidence |
| --- | --- |
| `1.0` | Resolved by construction - a constructor or overload matched exactly |
| `0.9` | Same-module declaration, typed local, or default constructor |
| `0.85` | Imported from a named module |
| `0.8` | Inherited from a supertype, or an external target |
| `0.75` | Call to an imported class resolved through its import |
| `0.6` | Pointcut `args(...)` matched on arity only |
| `0.55` | Pointcut primitive matched by static approximation |
| `0.3` | Empty pointcut - the advice matches everything |
| `0` | Phantom - nothing was resolved |

Practical rule: `>= 0.75` is safe to report as fact, `0.5`-`0.7` deserves a hedge, and `0`
carries no information about the target at all.

## `external` means outside the project

An edge with `external: true` points at a node like `ext:axios` or `ext:fastapi`, and its
`externalModule` names the package.

Consequences that are easy to get wrong:

- An external target is **not** dead code. It is a real dependency you do not index.
- An external target is **not** an unresolved call. It was resolved, just to the boundary.
- `find_dead_code` ignores external targets, so a method whose only caller is external can
  still look dead. Cross-check `find_external_dependencies`.

## Phantom nodes

A phantom target means the resolver saw a call but could not name its destination. Phantoms
carry `confidence: 0` and `resolved: false`, and their ids are prefixed:

| Prefix | Origin |
| --- | --- |
| `__phantom__:` | A call site with no resolvable target |
| `__reflect__:` | A runtime lookup whose type or method was not found |
| `__inject__:` | An injection marker that named neither a type nor a package |

Phantoms are **inventory, not findings**. A phantom is a statement about the analyser, not
about the code. Never report one as "calls something unknown" without reading its `reason` -
that field says which lookup step failed.

## Why "no callers" can be legitimate and wrong at the same time

Five ways a real caller produces no inbound `CALLS` edge:

1. **The index is stale.** Always `index_status` first. This is the most common cause.
2. **Dynamic dispatch.** The call goes through an interface; look for
   `DYNAMIC_DISPATCH` inbound edges and use `find_implementations`.
3. **Framework invocation.** Routes, listeners, schedulers, and tests are entry points,
   not calls. Check `find_entry_points` and `find_routes`.
4. **Reflection.** `Class.forName`, `getattr`, `importlib`, and dynamic `import()` produce
   `REFLECTS` edges, not `CALLS`. Check `find_reflections`.
5. **The caller is external.** Only in-project call edges are recorded. Check
   `find_external_dependencies`.

So the correct phrasing is "no in-project static callers", not "unused".

## Stale indexes and `force`

Incremental crawls compare file content and mtime against a manifest. That covers normal
editing. It does **not** cover the working tree changing underneath the index:

- after a rebase, merge, or `git reset` that rewrote history
- after switching branches with a large diff
- after `git stash pop`

A file whose content changed but whose mtime was reset can be skipped, leaving edges that
point at declarations that no longer exist. Pass `force: true` to `crawl_project` in those
cases. If results look impossible, forcing a re-index is cheaper than debugging the graph.

## Token budgeting

List-returning tools accept `max_tokens` and `cursor`, adding a `page` block with
`totalCount`, `returnedCount`, `truncated`, `estimatedTokens`, and `nextCursor`.

Truncation is reported, never silent: if `truncated` is true the answer is incomplete and
you should either widen `max_tokens` or say so. Paging never returns an empty page while
items remain, so a continuation loop terminates.
