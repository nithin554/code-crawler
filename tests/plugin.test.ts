import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
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

  it("has a workflow that validates before publishing", () => {
    const workflow = read(".github/workflows/publish-clawhub.yml");
    expect(workflow).toContain("secrets.CLAWHUB_TOKEN");
    expect(workflow).toContain("skill publish ./skills/code-crawler");
    expect(workflow).toContain("--slug code-crawler");
    expect(workflow).toContain("--owner nithin554");
    expect(workflow).toContain("--dry-run");
  });

  // Without an explicit --version the CLI assumes 1.0.0, so every release after
  // the first collides with the version already on the registry.
  it("publishes the skill at the release tag version", () => {
    const workflow = read(".github/workflows/publish-clawhub.yml");
    expect(workflow).toContain("workflow_call:");
    // The flag must carry the derived version, not a literal.
    expect(workflow).toMatch(/--version "\$\{VERSION\}"/);
    expect(workflow).toMatch(/version=\$\{TAG#v\}/);
    expect(workflow).toContain("ref: ${{ steps.release.outputs.tag }}");
  });

  it("is wired to the release tag created by the publish workflow", () => {
    const workflow = read(".github/workflows/publish.yml");
    expect(workflow).toContain("uses: ./.github/workflows/publish-clawhub.yml");
    expect(workflow).toContain("tag: ${{ needs.create-release.outputs.tag }}");
  });

  // A reusable workflow inherits the GITHUB_TOKEN permissions of the job that
  // calls it, so the grant has to be on the caller, not only in the called file.
  it("grants the called publish job a read-only token", () => {
    const workflow = read(".github/workflows/publish.yml");
    const start = workflow.indexOf("  publish-clawhub:");
    expect(start).toBeGreaterThan(-1);
    const called = workflow.slice(start, workflow.indexOf("  publish-mcp-registry:"));
    expect(called).toContain("uses: ./.github/workflows/publish-clawhub.yml");
    expect(called).toMatch(/permissions:\r?\n {6}contents: read\r?\n/);
  });
});
