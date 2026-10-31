import type { FrameworkModule } from "./types.js";

/** FastAPI: verb decorators register routes, `Depends` injects a parameter. */
export const fastapi: FrameworkModule = {
  name: "fastapi",
  evidence: ["fastapi"],
  entryPoints: {
    get: { kind: "http", httpMethod: "GET" },
    post: { kind: "http", httpMethod: "POST" },
    put: { kind: "http", httpMethod: "PUT" },
    delete: { kind: "http", httpMethod: "DELETE" },
    patch: { kind: "http", httpMethod: "PATCH" },
    head: { kind: "http", httpMethod: "HEAD" },
    options: { kind: "http", httpMethod: "OPTIONS" },
    trace: { kind: "http", httpMethod: "TRACE" },
  },
  paramMarkers: { "Depends(": "fastapi" },
};
