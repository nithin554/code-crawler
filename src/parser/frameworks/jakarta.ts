import type { FrameworkModule } from "./types.js";

/** Jakarta EE / JSR-330 injection annotations. */
export const jakarta: FrameworkModule = {
  name: "jakarta",
  evidence: ["jakarta.", "javax."],
  injections: { Inject: true, Resource: true, ManagedProperty: true },
};
