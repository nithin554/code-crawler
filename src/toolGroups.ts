/**
 * Presentation metadata for the tool surface: which group each tool is
 * documented under, and the one-line question that group answers.
 *
 * The list of tools themselves is *not* duplicated here — it is read from the
 * live MCP registry (`listTools()`), so a tool can never be documented without
 * existing, or exist without being documented. This file only says where each
 * registered name is filed, and `tests/docs-generated.test.ts` fails when a
 * registered tool is missing from every group or a group names a tool that no
 * longer exists.
 */
export interface ToolGroup {
  /** Anchor of the matching section in `docs/tools.html`. */
  id: string;
  title: string;
  /** The question this group of tools answers, shown in the docs table. */
  answers: string;
  tools: string[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "index",
    title: "Index &amp; schema",
    answers: "What is indexed, and what is the graph model?",
    tools: ["crawl_project", "index_status", "clear_index", "get_schema", "export_graph"],
  },
  {
    id: "lookup",
    title: "Symbol lookup",
    answers: "Where is this symbol, what is its id, and what is it?",
    tools: ["search_symbols", "get_node", "explain_symbol"],
  },
  {
    id: "calls",
    title: "Call graph",
    answers: "What calls what, how is it connected, and where does it not resolve?",
    tools: [
      "get_callers",
      "get_callees",
      "trace_path",
      "get_subgraph",
      "find_cycles",
      "find_unresolved",
    ],
  },
  {
    id: "dynamic",
    title: "Dynamic behaviour",
    answers: "What actually executes, and what intercepts it?",
    tools: [
      "trace_execution",
      "find_implementations",
      "find_aspects",
      "get_decorators",
      "find_annotated",
    ],
  },
  {
    id: "wiring",
    title: "Run-time wiring",
    answers: "What does a framework invoke, inject, publish or reflect on?",
    tools: [
      "find_entry_points",
      "find_routes",
      "find_injections",
      "find_reflections",
      "find_event_flows",
      "find_external_dependencies",
    ],
  },
  {
    id: "analytics",
    title: "Analytics &amp; impact",
    answers: "Where is the risk, what is unused, and what breaks if I change this?",
    tools: ["find_hotspots", "find_dead_code", "impact_analysis", "change_impact"],
  },
];

/** Every grouped name, in group order. */
export function groupedToolNames(): string[] {
  return TOOL_GROUPS.flatMap((group) => group.tools);
}

/** The group a tool is filed under, or `undefined` when it is not filed anywhere. */
export function groupOf(tool: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => group.tools.includes(tool));
}
