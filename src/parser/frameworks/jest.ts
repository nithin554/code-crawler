import type { FrameworkModule } from "./types.js";

/** Jest/Mocha test declarations. */
export const jest: FrameworkModule = {
  name: "jest",
  evidence: ["@jest/", "jest", "mocha"],
  entryPoints: {
    Test: { kind: "test" },
    It: { kind: "test" },
  },
};
