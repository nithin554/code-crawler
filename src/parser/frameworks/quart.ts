import type { FrameworkModule } from "./types.js";

/**
 * Quart: Flask's async twin, so it shares Flask's decorator surface and adds the
 * verb decorators. It also registers `websocket` endpoints.
 */
export const quart: FrameworkModule = {
  name: "quart",
  evidence: ["quart"],
  entryPoints: {
    route: { kind: "http", httpMethod: "ANY" },
    api_route: { kind: "http", httpMethod: "ANY" },
    websocket: { kind: "http", httpMethod: "WEBSOCKET" },
    websocket_route: { kind: "http", httpMethod: "WEBSOCKET" },
    get: { kind: "http", httpMethod: "GET" },
    post: { kind: "http", httpMethod: "POST" },
    put: { kind: "http", httpMethod: "PUT" },
    delete: { kind: "http", httpMethod: "DELETE" },
    patch: { kind: "http", httpMethod: "PATCH" },
    head: { kind: "http", httpMethod: "HEAD" },
    options: { kind: "http", httpMethod: "OPTIONS" },
  },
};
