import type { FrameworkModule } from "./types.js";

/** pytest: fixtures, parametrization, and `@pytest.mark.*` decorated tests. */
export const pytest: FrameworkModule = {
  name: "pytest",
  evidence: ["pytest"],
  entryPoints: {
    fixture: { kind: "test" },
    parametrize: { kind: "test" },
  },
  qualifiedPrefixes: { "mark.": { kind: "test" } },
};
