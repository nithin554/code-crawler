import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { GraphStore } from "../src/graph/store.js";

/**
 * Runtime-verified accuracy.
 *
 * The four projects in `manifest.json` are crawled but never executed, so their
 * ground truth is hand-verified. This script closes that gap for the part of the
 * graph that matters most and that static truth cannot decide: virtual dispatch.
 *
 * It compiles a small fixture, runs it, and treats the program's own output as
 * ground truth. Each implementation prints a line when its method runs, so the
 * recorded log states exactly which dispatch targets executed.
 *
 * Two different questions are asked, and they are deliberately not combined into
 * one score:
 *
 *   1. Soundness. Every method the log shows running must be reachable in the
 *      graph. A missing edge here is a defect and fails the run.
 *   2. Over-approximation. The graph may also claim an edge to a type the run
 *      never exercised (`Triangle`). That edge is not false - the method really
 *      does implement the interface - but this run does not prove it, so it is
 *      reported as unexercised rather than counted as a pass. Pretending it is a
 *      false positive would understate the graph; pretending it is verified
 *      would overstate it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "dispatch");
const REPORTS = path.join(HERE, "reports");

/** The interface method the fixture dispatches through: `Shape.area`. */
const INTERFACE_METHOD = "fixture.Shape#area";

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  confidence: number | null;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The fixture logs Java-natural method names (`fixture.Circle.area`) while graph node ids use
 * `#` before the member (`fixture.Circle#area`). Translate rather than changing the fixture, so
 * the recorded log stays ordinary Java output.
 */
function toNodeId(javaMethod: string): string {
  const dot = javaMethod.lastIndexOf(".");
  return dot === -1 ? javaMethod : `${javaMethod.slice(0, dot)}#${javaMethod.slice(dot + 1)}`;
}

/** Compile the fixture and return the call log the program printed. */
function execute(): { log: string[]; invoked: string[]; dispatched: string[] } {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "cc-runtime-"));
  try {
    const sources = fs
      .readdirSync(path.join(FIXTURE, "fixture"))
      .filter((f) => f.endsWith(".java"))
      .map((f) => path.join(FIXTURE, "fixture", f));
    if (sources.length === 0) throw new Error(`no Java sources under ${FIXTURE}`);
    run("javac", ["-d", classes, ...sources]);
    const stdout = run("java", ["-cp", classes, "fixture.Main"]);
    const log = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const invoked = log
      .filter((l) => l.startsWith("[call] "))
      .map((l) => toNodeId(l.slice("[call] ".length).trim()));
    const dispatched = log
      .filter((l) => l.startsWith("[dispatch] "))
      .map((l) => l.slice(l.indexOf("-> ") + 3).trim());
    if (invoked.length === 0) throw new Error("fixture ran but logged no calls");
    return { log, invoked, dispatched };
  } finally {
    fs.rmSync(classes, { recursive: true, force: true });
  }
}

async function graphEdges(): Promise<EdgeRow[]> {
  const config = loadConfig({ projectRoot: FIXTURE });
  const store = new GraphStore(":memory:", { maxDepth: config.maxDepth });
  try {
    await crawlProject(store, FIXTURE, config.excludeDirs, {
      respectGitignore: config.respectGitignore,
      maxFileBytes: config.maxFileBytes,
      force: true,
    });
    return store.raw<EdgeRow>(
      "SELECT source, target, kind, json_extract(properties, '$.confidence') AS confidence FROM edges"
    );
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const { log, invoked, dispatched } = execute();
  process.stderr.write(`ran fixture.Main, ${invoked.length} method call(s) observed\n`);

  const edges = await graphEdges();
  const dispatch = edges.filter((e) => e.kind === "DYNAMIC_DISPATCH");
  const calls = edges.filter((e) => e.kind === "CALLS");

  const failures: string[] = [];

  // 1. Every type the run actually dispatched to must have a DYNAMIC_DISPATCH edge
  //    from the interface that declared the method. This is the soundness claim.
  for (const implClass of dispatched) {
    const method = `${implClass}#area`;
    const fromInterface = dispatch.some(
      (e) => e.source === INTERFACE_METHOD && e.target === method
    );
    if (!fromInterface)
      failures.push(
        `runtime dispatched to ${implClass} but the graph has no edge ${INTERFACE_METHOD} -> ${method}`
      );
  }

  // 2. Every method the log shows running must be reachable at all.
  for (const method of invoked) {
    const reachable = edges.some((e) => e.target === method);
    if (!reachable) failures.push(`runtime called ${method} but the graph has no edge to it`);
  }

  // 3. The static call from describe() into the interface must exist, otherwise
  //    the dispatch edges have no anchor and the whole chain is disconnected.
  const anchored = calls.some(
    (e) => e.source === "fixture.Main#describe" && e.target === INTERFACE_METHOD
  );
  if (!anchored) failures.push(`graph is missing fixture.Main#describe -> ${INTERFACE_METHOD}`);

  // 4. Dispatch targets the graph claims that this run never exercised.
  const invokedMethods = new Set(invoked);
  const unexercised = dispatch.filter(
    (e) => e.source === INTERFACE_METHOD && !invokedMethods.has(e.target)
  );

  const lines: string[] = [];
  lines.push("# Runtime-verified dispatch", "");
  lines.push(
    "Generated by `npm run bench:runtime`. Unlike the accuracy benchmark, the ground truth here",
    "comes from executing the code: the fixture prints a line whenever a method runs, so the log",
    "below is a real call log, not a reading of the source.",
    ""
  );
  lines.push("## Observed call log", "", "```");
  for (const l of log) lines.push(l);
  lines.push("```", "");

  lines.push("## Dispatch edges", "");
  lines.push("| source | target | confidence | proven by this run |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of dispatch) {
    const proven = invokedMethods.has(e.target) ? "yes" : "no (unexercised)";
    lines.push(`| \`${e.source}\` | \`${e.target}\` | ${e.confidence ?? "none"} | ${proven} |`);
  }
  lines.push("");

  lines.push("## Result", "");
  const exercised = dispatch.filter((e) => invokedMethods.has(e.target)).length;
  lines.push(`- ${invoked.length} method call(s) observed at runtime.`);
  lines.push(`- ${exercised} of ${dispatch.length} dispatch edge(s) proven by observation.`);
  lines.push(`- ${unexercised.length} dispatch edge(s) unexercised in this run.`);
  lines.push(
    "- These unexercised edges are not false positives: the target really does implement the",
    "  interface, so the edge becomes true as soon as that type is constructed. They are",
    "  over-approximation, which is why `DYNAMIC_DISPATCH` carries a flat confidence of 0.80",
    "  instead of 1.00. A single-implementation interface gives this mechanism nothing to",
    "  over-approximate; an interface with many implementations gives it plenty.",
    ""
  );
  if (failures.length > 0) {
    lines.push("## Failures", "");
    for (const f of failures) lines.push(`- ${f}`);
    lines.push("");
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, "runtime.md"), `${lines.join("\n")}\n`, "utf8");
  process.stderr.write(
    `${dispatch.length} dispatch edges, ${exercised} proven, ${unexercised.length} unexercised\n`
  );
  process.stderr.write(
    `report: ${path.relative(process.cwd(), path.join(REPORTS, "runtime.md"))}\n`
  );

  const total = invoked.length + (anchored ? 0 : 1);
  console.log(`runtime: ${total} check(s), ${failures.length} failure(s)`);
  if (failures.length > 0) {
    console.error("\nruntime discrepancies:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main().catch((err: unknown) => {
  console.error(`runtime check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
