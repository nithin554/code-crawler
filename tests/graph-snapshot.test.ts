import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";

/**
 * Golden graph snapshots.
 *
 * Each fixture is crawled into a fresh store and serialized to a stable,
 * machine-independent listing of every node and edge. The snapshot is the
 * contract for the graph *shape*, so a parser change that adds, drops or
 * re-points a node shows up as a reviewable diff instead of passing silently.
 *
 * Property blobs are deliberately excluded: they carry line numbers and
 * resolver confidences, which are noisy and covered by targeted tests.
 */
const FIXTURES = [
  { name: "java", dir: ["java", "sample"] },
  { name: "python", dir: ["python", "sample"] },
  { name: "typescript", dir: ["typescript", "sample"] },
] as const;

let store: GraphStore;

beforeEach(() => {
  store = new GraphStore(":memory:", { maxDepth: 10 });
  store.clearAll();
});

/** Rewrite absolute fixture paths so snapshots do not depend on the checkout. */
function normalizer(root: string): (value: string) => string {
  const portableRoot = root.replace(/\\/g, "/");
  return (value: string) => value.replace(/\\/g, "/").replaceAll(portableRoot, "<fixture>");
}

function dumpGraph(root: string): string {
  const normalize = normalizer(root);
  const nodes = store
    .raw<{ kind: string; id: string }>("SELECT kind, id FROM nodes ORDER BY id, kind")
    .map((node) => `${node.kind} ${normalize(node.id)}`);
  const edges = store
    .raw<{ source: string; kind: string; target: string }>(
      "SELECT source, kind, target FROM edges ORDER BY kind, source, target"
    )
    .map((edge) => `${normalize(edge.source)} -${edge.kind}-> ${normalize(edge.target)}`);

  return [`# nodes (${nodes.length})`, ...nodes, "", `# edges (${edges.length})`, ...edges].join(
    "\n"
  );
}

describe.each(FIXTURES)("$name graph snapshot", (fixture) => {
  it("matches the recorded graph", async () => {
    const dir = path.join(__dirname, "fixtures", ...fixture.dir);
    await crawlProject(store, dir, loadConfig().excludeDirs, {});
    expect(dumpGraph(dir)).toMatchSnapshot();
  });
});
