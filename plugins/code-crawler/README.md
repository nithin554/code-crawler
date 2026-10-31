# Code Crawler

Static and dynamic call tracing MCP server backed by a SQLite property graph of your
codebase.

This directory is the ClawHub plugin bundle. It is a Claude-format bundle
(`.claude-plugin/plugin.json` plus `.mcp.json`), so ClawHub publishes it as a
`bundle-plugin` rather than as a bare package:

```bash
clawhub install code-crawler
```

The bundle carries no server code: `.mcp.json` launches the published npm package
with `npx -y @nithin554/code-crawler serve`, so every release of the plugin tracks
the npm release with the same version.

`package.json` here is packaging metadata only. ClawHub reads a package manifest
to inspect the bundle and to build its ClawPack artifact, and reports "package
metadata is missing" without one. Its `version` is the one ClawHub serves, so it
is not maintained by hand: the release workflow stamps the tag's version into it
and packs the bundle, and the committed `0.0.0` is a placeholder.

The server resolves a project per tool call and keeps each repository's graph in
`<project>/.code-crawler/index.db`, so one plugin install serves every repository
you open.

- Source: https://github.com/nithin554/code-crawler
- Docs: https://nithin554.github.io/code-crawler/
- Skill: https://clawhub.ai/nithin554/skills/code-crawler
