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
        lines: 87,
        statements: 82,
        functions: 89,
        branches: 64,
        "src/graph/**": {
          lines: 92,
          statements: 88,
          functions: 88,
          branches: 72,
        },
        "src/resolver/**": {
          lines: 85,
          statements: 80,
          functions: 86,
          branches: 69,
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
