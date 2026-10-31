import type { FrameworkModule } from "./types.js";

/**
 * FastAPI: verb decorators register routes, `Depends` injects a parameter.
 *
 * `api_route` takes an explicit `methods` list, and `websocket` /
 * `websocket_route` register socket endpoints, so all three are verb-agnostic.
 * Flask declares the same names as a catch-all fallback, so the file's imports
 * decide between them rather than the decorator name alone.
 */
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
    api_route: { kind: "http", httpMethod: "ANY" },
    websocket: { kind: "http", httpMethod: "WEBSOCKET" },
    websocket_route: { kind: "http", httpMethod: "WEBSOCKET" },
  },
  paramMarkers: { "Depends(": "fastapi" },
};
