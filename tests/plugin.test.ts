import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

// This checkout may be CRLF while the committed file is LF.
function workflow(file: string): string {
  return read(file).replace(/\r\n/g, "\n");
}

function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`  ${job}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + job.length + 3);
  const next = rest.search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

interface Author {
  name: string;
  url?: string;
}

interface PluginManifest {
  $schema?: string;
  name: string;
  version?: string;
  displayName?: string;
  description: string;
  author: Author;
  homepage: string;
  repository: string;
  license: string;
  keywords: string[];
}

interface McpServer {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  $schema?: string;
  mcpServers: Record<string, McpServer>;
}

interface Marketplace {
  name: string;
  owner: { name: string };
  plugins: Array<{ name: string; source: string; description: string }>;
}

interface PackageJson {
  name: string;
  description: string;
  license: string;
  homepage: string;
  repository: { url: string };
  files: string[];
  bin: Record<string, string>;
}

const pkg = JSON.parse(read("package.json")) as PackageJson;
const repository = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const agentManifest = JSON.parse(read("plugin.json")) as PluginManifest;
const claudeManifest = JSON.parse(read(".claude-plugin/plugin.json")) as PluginManifest;
const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as Marketplace;
const agentMcp = JSON.parse(read("mcp.json")) as McpConfig;
const claudeMcp = JSON.parse(read(".mcp.json")) as McpConfig;

describe("agent plugin manifest", () => {
  it("uses the Agent Plugins 1.0 schema", () => {
    expect(agentManifest.$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    );
  });

  it("declares only fields the closed 1.0 schema allows", () => {
    const allowed = new Set([
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ]);
    for (const key of Object.keys(agentManifest)) {
      expect(allowed.has(key), `plugin.json has unknown field "${key}"`).toBe(true);
    }
  });

  it("names the plugin after the skill directory", () => {
    expect(agentManifest.name).toBe("code-crawler");
    expect(agentManifest.name).toMatch(/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/);
    expect(agentManifest.name).not.toMatch(/--|\.\./);
    expect(fs.existsSync(path.join(ROOT, "skills", agentManifest.name, "SKILL.md"))).toBe(true);
  });

  it("reuses package metadata for discovery", () => {
    expect(agentManifest.description).toBe(pkg.description);
    expect(agentManifest.author.name).toBe("nithin554");
    expect(agentManifest.homepage).toBe(pkg.homepage);
    expect(agentManifest.repository).toBe(repository);
    expect(agentManifest.license).toBe(pkg.license);
    expect(agentManifest.keywords.length).toBeGreaterThan(0);
  });
});

describe("plugin MCP configuration", () => {
  it("uses the Agent Plugins MCP schema", () => {
    expect(agentMcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(Object.keys(agentMcp).sort()).toEqual(["$schema", "mcpServers"]);
  });

  it("launches the published package over stdio", () => {
    const server = agentMcp.mcpServers["code-crawler"];
    expect(server, "mcp.json has no code-crawler server").toBeDefined();
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", pkg.name, "serve"]);
  });

  it("resolves one database per project instead of pinning a shared file", () => {
    const server = agentMcp.mcpServers["code-crawler"];
    expect(server.env?.CODECRAWLER_PLUGIN).toBe("1");
    expect(server.env?.CODECRAWLER_DB).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal placeholder the client expands
    expect(server.env?.CODECRAWLER_PLUGIN_ROOT).toBe("${PLUGIN_ROOT}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal placeholder the client expands
    expect(server.env?.CODECRAWLER_PLUGIN_DATA).toBe("${PLUGIN_DATA}");
    const claudeServer = claudeMcp.mcpServers["code-crawler"];
    expect(claudeServer.env?.CODECRAWLER_PLUGIN).toBe("1");
    expect(claudeServer.env?.CODECRAWLER_DB).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal placeholder the client expands
    expect(claudeServer.env?.CODECRAWLER_PLUGIN_ROOT).toBe("${CLAUDE_PLUGIN_ROOT}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts the literal placeholder the client expands
    expect(claudeServer.env?.CODECRAWLER_PLUGIN_DATA).toBe("${CLAUDE_PLUGIN_DATA}");
  });

  it("gives Claude Code the same command and args", () => {
    const claudeServer = claudeMcp.mcpServers["code-crawler"];
    expect(claudeServer.command).toBe("npx");
    expect(claudeServer.args).toEqual(["-y", pkg.name, "serve"]);
  });
});

describe("Claude Code manifest and marketplace", () => {
  it("has a matching plugin manifest", () => {
    expect(claudeManifest.name).toBe(agentManifest.name);
    expect(claudeManifest.description).toBe(agentManifest.description);
    expect(claudeManifest.repository).toBe(repository);
    expect(claudeManifest.license).toBe(pkg.license);
  });

  it("lists the plugin at the repository root", () => {
    expect(marketplace.name).toBe(agentManifest.name);
    expect(marketplace.owner.name).toBe("nithin554");
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(agentManifest.name);
    expect(entry.source).toBe("./");
    expect(entry.description).toBe(agentManifest.description);
  });

  it("ships the plugin files in the npm tarball", () => {
    for (const file of ["plugin.json", "mcp.json", ".claude-plugin"]) {
      expect(pkg.files).toContain(file);
    }
  });
});

describe("ClawHub publishing", () => {
  it("carries runtime metadata for the package install", () => {
    const skill = read("skills/code-crawler/SKILL.md");
    expect(skill).toMatch(/^metadata:\r?\n {2}openclaw:/m);
    expect(skill).toContain(`package: "${pkg.name}"`);
    for (const bin of Object.keys(pkg.bin)) {
      expect(skill).toContain(`"${bin}"`);
    }
  });

  it("delegates the skill publish to the official ClawHub workflow", () => {
    const workflow = read(".github/workflows/publish-clawhub.yml");
    expect(workflow).toContain(
      "uses: openclaw/clawhub/.github/workflows/skill-publish.yml@v0.24.1"
    );
    expect(workflow).toContain("skill_path: skills/code-crawler");
    expect(workflow).toContain("owner: nithin554");
    expect(workflow).toContain("dry_run: ${{ inputs.dry_run }}");
  });

  // The upstream workflow names the secret `clawhub_token`, and `secrets:
  // inherit` does not rename it. The value has to be a repository secret: only
  // a job that declares the `clawhub-publish` environment can read that
  // environment's secrets, a `uses:` job cannot declare one, and GitHub drops
  // secret-valued job outputs ("Skip output ... since it may contain secret"),
  // so neither the guard nor an output can carry the value across that boundary.
  it("renames the repository token to the name upstream reads", () => {
    for (const file of [
      ".github/workflows/publish-clawhub.yml",
      ".github/workflows/publish-plugin.yml",
    ]) {
      const text = workflow(file);
      // The gate is the only job that may bind the environment.
      expect(jobBlock(text, "guard")).toContain("environment: clawhub-publish");

      const mappings = text.match(/^ {6}clawhub_token: .+$/gm) ?? [];
      // Publish and retry both read the secret straight from the repository.
      expect(mappings).toEqual([
        "      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}",
        "      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}",
      ]);
      // A `uses:` job cannot read an environment secret, and forwarding one
      // through a job output is silently dropped, so never do either.
      expect(text).not.toContain("needs.guard.outputs");
      expect(text).not.toMatch(/outputs:\s*\n\s+clawhub_token/);
    }
  });

  // Upstream takes no `version` input and bumps the patch of the registry's
  // latest version, so the version is owned by ClawHub rather than by the tag.
  it("leaves the skill version to ClawHub instead of inventing one", () => {
    const workflow = read(".github/workflows/publish-clawhub.yml");
    expect(workflow).not.toMatch(/^\s*version:/m);
    expect(workflow).not.toContain("--version");
  });

  it("pins both ClawHub workflows to one upstream release", () => {
    const refs = [
      ...read(".github/workflows/publish-clawhub.yml").matchAll(
        /openclaw\/clawhub\/\.github\/workflows\/[\w-]+\.yml@(\S+)/g
      ),
      ...read(".github/workflows/publish-plugin.yml").matchAll(
        /openclaw\/clawhub\/\.github\/workflows\/[\w-]+\.yml@(\S+)/g
      ),
    ].map((match) => match[1]);
    // A floating `v1` ref does not exist upstream, so every call pins a tag.
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set(["v0.24.1"]));
  });

  it("is wired to the release tag created by the publish workflow", () => {
    const workflow = read(".github/workflows/publish.yml");
    for (const file of ["publish-clawhub", "publish-plugin"]) {
      expect(workflow).toContain(`uses: ./.github/workflows/${file}.yml`);
    }
    expect(workflow).toContain("tag: ${{ needs.create-release.outputs.tag }}");
    expect(workflow).toContain("secrets: inherit");
  });

  // Upstream makes exactly one attempt, so a throttle would otherwise turn an
  // ordinary "Too many writes in a short period of time" into a failed release.
  it("retries a throttled publish instead of failing the release", () => {
    for (const file of ["publish-clawhub", "publish-plugin"]) {
      const workflow = read(`.github/workflows/${file}.yml`);
      expect(workflow).toContain("publish-retry:");
      expect(workflow).toMatch(/if: .*!inputs\.dry_run/);
    }
  });

  // Nothing but `main` may write to the registries, so the publishes sit behind
  // the `clawhub-publish` environment, whose deployment branch policy allows
  // only that branch. A job that calls a reusable workflow cannot declare an
  // environment, so the gate is a plain job the publishers depend on.
  it("restricts both publishes to main through the publish environment", () => {
    for (const file of ["publish-clawhub", "publish-plugin"]) {
      const text = workflow(`.github/workflows/${file}.yml`);
      const blocks = text.split(/\n(?= {2}[a-z][\w-]*:\n)/);
      const guard = blocks.find((block) => block.startsWith("  guard:\n"));
      expect(guard).toBeDefined();
      expect(guard).toContain("environment: clawhub-publish");
      expect(guard).not.toContain("uses:");

      const publishers = blocks.filter((block) => block.includes("uses: openclaw/"));
      expect(publishers.length).toBeGreaterThan(0);
      for (const publisher of publishers) {
        expect(publisher).toMatch(/^ {4}needs: guard$|^ {6}- guard$/m);
      }
    }
  });

  // A reusable workflow can only narrow the GITHUB_TOKEN permissions of the job
  // that calls it, never widen them, so every grant the nested jobs request must
  // also exist on the caller. Missing one does not fail at publish time: GitHub
  // rejects the whole workflow as invalid and the run dies with a
  // `startup_failure` before a single job starts.
  it("grants the called publish jobs every permission they request", () => {
    const caller = workflow(".github/workflows/publish.yml");

    for (const [job, file] of [
      ["publish-clawhub", "publish-clawhub"],
      ["publish-clawhub-plugin", "publish-plugin"],
    ]) {
      const called = workflow(`.github/workflows/${file}.yml`);
      const calledJobs = called.slice(called.indexOf("\njobs:\n"));
      const requested = [...calledJobs.matchAll(/^ {6}([\w-]+): (read|write)$/gm)].map(
        (match) => `${match[1]}: ${match[2]}`
      );

      expect(requested).toContain("contents: read");
      // Upstream mints an OIDC token to pin its own CLI source.
      expect(requested).toContain("id-token: write");

      const callerGrants = jobBlock(caller, job);
      for (const grant of new Set(requested)) {
        expect(callerGrants).toContain(grant);
      }
    }

    // The called workflow uploads its inspector and publish reports.
    expect(jobBlock(caller, "publish-clawhub-plugin")).toContain("actions: read");
  });
});

describe("ClawHub plugin bundle", () => {
  const bundle = "plugins/code-crawler";
  const bundleManifest = JSON.parse(read(`${bundle}/.claude-plugin/plugin.json`)) as PluginManifest;
  const bundleMcp = JSON.parse(read(`${bundle}/.mcp.json`)) as McpConfig;

  it("declares exactly one bundle marker so the family is unambiguous", () => {
    const markers = [".codex-plugin", ".claude-plugin", ".cursor-plugin"].filter((dir) =>
      fs.existsSync(path.join(ROOT, bundle, dir, "plugin.json"))
    );
    expect(markers).toEqual([".claude-plugin"]);
  });

  // ClawHub names a bundle after its directory, so the folder fixes the slug.
  it("is named after the directory ClawHub publishes it as", () => {
    expect(path.basename(bundle)).toBe(claudeManifest.name);
    expect(bundleManifest.name).toBe(claudeManifest.name);
  });

  // The bundle carries no server code; it resolves the published package.
  it("mirrors the root manifests instead of drifting from them", () => {
    expect(bundleManifest).toEqual(claudeManifest);
    expect(bundleMcp).toEqual(claudeMcp);
    expect(bundleMcp.mcpServers["code-crawler"].args).toEqual(["-y", pkg.name, "serve"]);
  });

  // A `version` here would have to be bumped by hand and would still be
  // overridden, because the publish workflow passes the release version.
  it("carries no version and no package.json of its own", () => {
    expect(bundleManifest.version).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, bundle, "package.json"))).toBe(false);
  });
});
