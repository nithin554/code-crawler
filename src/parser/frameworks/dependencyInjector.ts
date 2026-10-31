import type { FrameworkModule } from "./types.js";

/** dependency-injector: `@inject` / `@injectable` markers and `Inject(...)` parameters. */
export const dependencyInjector: FrameworkModule = {
  name: "dependency-injector",
  evidence: ["dependency_injector"],
  injections: { inject: true, injectable: true, autowired: true, provide: true },
  paramMarkers: { "Inject(": "dependency-injector" },
};
