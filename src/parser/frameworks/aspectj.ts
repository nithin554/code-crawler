import type { FrameworkModule } from "./types.js";

/** AspectJ: advice annotations and the `@Aspect` class marker. */
export const aspectj: FrameworkModule = {
  name: "aspectj",
  evidence: ["org.aspectj"],
  aspects: ["Aspect"],
  advice: {
    Before: "before",
    After: "after",
    Around: "around",
    AfterReturning: "afterReturning",
    AfterThrowing: "afterThrowing",
    Pointcut: "pointcut",
  },
};
