import type { FrameworkModule } from "./types.js";

/** JUnit: test-method annotations that make a method a framework-invoked root. */
export const junit: FrameworkModule = {
  name: "junit",
  evidence: ["org.junit"],
  entryPoints: {
    Test: { kind: "test" },
    ParameterizedTest: { kind: "test" },
    RepeatedTest: { kind: "test" },
  },
};
