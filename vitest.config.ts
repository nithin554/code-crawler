import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      // Floors sit just under the measured baseline so they catch regressions
      // without failing on incidental churn. Raise them when coverage climbs.
      thresholds: {
        lines: 84,
        statements: 79,
        functions: 88,
        branches: 61,
        "src/graph/**": {
          lines: 92,
          statements: 88,
          functions: 88,
          branches: 72,
        },
        "src/**/crawler.ts": {
          lines: 92,
          statements: 89,
          functions: 90,
          branches: 72,
        },
      },
    },
  },
});
