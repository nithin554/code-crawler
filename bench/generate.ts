/**
 * Deterministic synthetic-project generator for the benchmarks.
 *
 * The shape is deliberately boring but realistic for a crawler: many small
 * TypeScript modules, each exporting one service class with a handful of
 * methods that call each other and a few methods in neighbouring modules. That
 * produces a dense CALLS graph plus enough dead methods for `dead_code` to have
 * something to find.
 */
import fs from "node:fs";
import path from "node:path";

export interface GeneratedProject {
  root: string;
  files: number;
  lines: number;
  methods: number;
}

export interface GenerateOptions {
  /** Approximate total line count. File count is derived from it. */
  targetLines?: number;
  /** Seed for the deterministic PRNG. */
  seed?: number;
  /** Lines per generated module, including imports and boilerplate. */
  linesPerFile?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function moduleSource(
  index: number,
  moduleCount: number,
  methodsPerFile: number,
  rand: () => number
): { source: string; lines: number; methods: number } {
  const name = `Svc${index}`;
  // Reference a later module so imports always point forward and the graph is
  // acyclic enough for traversal queries to terminate quickly.
  const peerIndex = (index + 1) % moduleCount;
  const peer = `Svc${peerIndex}`;
  const out: string[] = [];

  out.push(`import { ${peer} } from "./mod${peerIndex}.js";`);
  out.push("");
  out.push(`export interface Payload${index} {`);
  out.push(`  id: string;`);
  out.push(`  weight: number;`);
  out.push(`  tags: string[];`);
  out.push(`}`);
  out.push("");
  out.push(`/** Generated service ${index}. */`);
  out.push(`export class ${name} {`);
  out.push(`  private readonly cache = new Map<string, number>();`);
  out.push(`  private readonly peer: ${peer};`);
  out.push("");
  out.push(`  constructor() {`);
  out.push(`    this.peer = new ${peer}();`);
  out.push(`  }`);

  for (let m = 0; m < methodsPerFile; m++) {
    const next = m + 1 < methodsPerFile ? m + 1 : null;
    const roll = rand();
    out.push("");
    out.push(`  /** Handles operation ${m} for ${name}. */`);
    out.push(`  public handle${index}_${m}(input: Payload${index}): number {`);
    out.push(`    const key = \`\${input.id}:${index}:${m}\`;`);
    out.push(`    const cached = this.cache.get(key);`);
    out.push(`    if (cached !== undefined) {`);
    out.push(`      return cached;`);
    out.push(`    }`);
    out.push(`    let total = input.weight + input.tags.length;`);
    if (next !== null) {
      out.push(`    total += this.handle${index}_${next}(input);`);
    }
    if (roll > 0.55) {
      out.push(`    total += this.peer.handle${peerIndex}_${m}(input as never);`);
    }
    if (roll > 0.85) {
      // Deliberately unresolvable, so the unresolved-call counter is exercised.
      out.push(`    total += (input as unknown as { opaque(): number }).opaque();`);
    }
    out.push(`    this.cache.set(key, total);`);
    out.push(`    return total;`);
    out.push(`  }`);
  }

  out.push("");
  out.push(`  /** Entry point used by the runtime wiring. */`);
  out.push(`  public run(input: Payload${index}): number {`);
  out.push(`    return this.handle${index}_0(input);`);
  out.push(`  }`);
  out.push(`}`);

  return {
    source: `${out.join("\n")}\n`,
    lines: out.length,
    methods: methodsPerFile + 1,
  };
}

export function generateProject(root: string, options: GenerateOptions = {}): GeneratedProject {
  const targetLines = options.targetLines ?? 100_000;
  const rand = mulberry32(options.seed ?? 1);
  const methodsPerFile = 16;
  // Boilerplate ~= 30 lines plus ~9 lines per method body.
  const linesPerFile = options.linesPerFile ?? 30 + methodsPerFile * 9;
  const moduleCount = Math.max(1, Math.round(targetLines / linesPerFile));

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ["node_modules/", "dist/", ""].join("\n"),
    "utf8"
  );

  let files = 0;
  let lines = 0;
  let methods = 0;
  for (let i = 0; i < moduleCount; i++) {
    const mod = moduleSource(i, moduleCount, methodsPerFile, rand);
    fs.writeFileSync(path.join(root, "src", `mod${i}.ts`), mod.source, "utf8");
    files += 1;
    lines += mod.lines;
    methods += mod.methods;
  }

  return { root, files, lines, methods };
}
