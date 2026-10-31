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

  // The skill workflow delegates to upstream, which names the secret
  // `clawhub_token` and cannot be renamed by `secrets: inherit`. The plugin
  // workflow runs the CLI itself, so it passes the value under its own name.
  it("passes the token to the publisher that reads it", () => {
    const skill = read(".github/workflows/publish-clawhub.yml");
    expect(skill.match(/^ {6}clawhub_token: .+$/gm) ?? []).toEqual([
      "      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}",
      "      clawhub_token: ${{ secrets.CLAWHUB_TOKEN }}",
    ]);

    const plugin = workflow(".github/workflows/publish-plugin.yml");
    // Publish and retry both read the secret straight from the environment.
    expect(plugin.match(/^ {10}CLAWHUB_TOKEN: .+$/gm) ?? []).toEqual([
      "          CLAWHUB_TOKEN: ${{ secrets.CLAWHUB_TOKEN }}",
      "          CLAWHUB_TOKEN: ${{ secrets.CLAWHUB_TOKEN }}",
    ]);

    // Forwarding a secret through a job output is silently dropped ("Skip
    // output ... since it may contain secret"), so never do it.
    for (const text of [skill, plugin]) {
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

  // A floating `v1` ref does not exist upstream, so the skill call pins a
  // release tag and the plugin workflow pins the CLI to the same release.
  it("pins both ClawHub publishers to one upstream release", () => {
    const skill = read(".github/workflows/publish-clawhub.yml");
    const refs = [
      ...skill.matchAll(/openclaw\/clawhub\/\.github\/workflows\/[\w-]+\.yml@(\S+)/g),
    ].map((match) => match[1]);
    expect(new Set(refs)).toEqual(new Set(["v0.24.1"]));

    const plugin = workflow(".github/workflows/publish-plugin.yml");
    expect(plugin).toContain('CLAWHUB_CLI_VERSION: "0.24.1"');
    expect(plugin).toContain('npx --yes "clawhub@$CLAWHUB_CLI_VERSION"');
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

  // Nothing but `main` may write to the registries. A job that calls a reusable
  // workflow cannot declare an environment, so the skill publishers sit behind a
  // plain gate job; the plugin jobs declare the environment themselves, which is
  // also what grants them the credential.
  it("restricts both publishes to main through the publish environment", () => {
    const skill = workflow(".github/workflows/publish-clawhub.yml");
    const blocks = skill.split(/\n(?= {2}[a-z][\w-]*:\n)/);
    const guard = blocks.find((block) => block.startsWith("  guard:\n"));
    expect(guard).toBeDefined();
    expect(guard).toContain("environment: clawhub-publish");
    expect(guard).not.toContain("uses:");

    const publishers = blocks.filter((block) => block.includes("uses: openclaw/"));
    expect(publishers.length).toBeGreaterThan(0);
    for (const publisher of publishers) {
      expect(publisher).toMatch(/^ {4}needs: guard$|^ {6}- guard$/m);
    }

    const plugin = workflow(".github/workflows/publish-plugin.yml");
    for (const job of ["publish", "publish-retry"]) {
      const block = jobBlock(plugin, job);
      expect(block).toContain("environment: clawhub-publish");
      expect(block).toMatch(/^ {6}- guard$/m);
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

      const callerGrants = jobBlock(caller, job);
      for (const grant of new Set(requested)) {
        expect(callerGrants).toContain(grant);
      }

      if (job === "publish-clawhub") {
        // Upstream mints an OIDC token to pin its own CLI source.
        expect(requested).toContain("id-token: write");
      }
    }

    // The plugin publish authenticates with the stored token through the
    // environment, so it must not ask for an OIDC token it never uses.
    const plugin = workflow(".github/workflows/publish-plugin.yml");
    expect(plugin.slice(plugin.indexOf("\njobs:\n"))).not.toContain("id-token: write");

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

  // A `version` in the manifest would have to be bumped by hand and would
  // still be overridden, because the publish workflow passes the release
  // version. The package.json below is packaging metadata instead.
  it("pins no version in the plugin manifests", () => {
    expect(claudeManifest.version).toBeUndefined();
    expect(bundleManifest.version).toBeUndefined();
  });

  // ClawHub reports "package metadata is missing" for a bundle with no
  // package.json, and cannot build a ClawPack tarball without a version.
  it("carries a package manifest so ClawHub can inspect and pack it", () => {
    const bundlePkg = JSON.parse(read(`${bundle}/package.json`)) as {
      name: string;
      version: string;
      files: string[];
    };

    expect(bundlePkg.name).toBe(claudeManifest.name);
    // The release version is stamped by CI, so the committed value is a
    // placeholder that never ships.
    expect(bundlePkg.version).toBe("0.0.0");
    // npm pack drops dot entries unless they are listed explicitly.
    for (const file of [".claude-plugin", ".mcp.json"]) {
      expect(bundlePkg.files).toContain(file);
    }
  });

  // A `version` bumped by hand would drift from the release it ships with, and
  // ClawHub rejects a tarball whose version disagrees with the published one.
  it("stamps the release version into the bundle before packing it", () => {
    const text = workflow(".github/workflows/publish-plugin.yml");
    const pack = jobBlock(text, "pack");

    expect(pack).toContain("VERSION: ${{ needs.prepare.outputs.version }}");
    expect(pack).toContain("pkg.version = process.env.VERSION;");
    expect(pack).toContain("npm pack ./plugins/code-crawler");
  });

  // The publish job does not check the repository out, so the stamped file only
  // reaches ClawHub through the tarball `pack` uploaded.
  it("publishes the packed tarball instead of the working tree", () => {
    const text = workflow(".github/workflows/publish-plugin.yml");

    for (const job of ["publish", "publish-retry"]) {
      const block = jobBlock(text, job);
      expect(block).toContain("uses: actions/download-artifact@v8");
      expect(block).toContain("name: clawhub-plugin-package");
      // A relative `dist/x.tgz` is parsed as a GitHub `owner/repo` shorthand, so
      // the CLI has to be handed an absolute path.
      expect(block).toContain('find "$PWD/dist" -maxdepth 1');
      expect(block).toContain('package publish "${tarballs[0]}"');
      expect(block).toContain('--source-commit "$COMMIT"');
    }
  });

  // Upstream inspects the bundle with `bun ... package validate`, which the CLI
  // refuses: "Plugin validation requires Node.js 22.13+ (22.x) or 24+". A
  // ClawPack always contains package/package.json, so that step always runs and
  // always fails, which is why the CLI is invoked here instead.
  it("runs the ClawHub CLI on Node rather than Bun", () => {
    const text = workflow(".github/workflows/publish-plugin.yml");

    expect(text).not.toContain("uses: openclaw/clawhub/");
    for (const job of ["publish", "publish-retry"]) {
      const block = jobBlock(text, job);
      expect(block).toContain("uses: actions/setup-node@v5");
      expect(block).toContain("node-version: 24");
      // `bundle-plugin` and `bun` share a prefix, so match the command.
      expect(block).not.toMatch(/(^|\s)bun\s/m);
    }
  });
});
