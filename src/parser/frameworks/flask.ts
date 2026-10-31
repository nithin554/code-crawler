import type { FrameworkModule } from "./types.js";

/**
 * Flask: `route`/`api_route` accept any verb, and 2.0 added the `get`/`post`/...
 * shortcut decorators. The shortcut names are also FastAPI's, so the file's
 * imports decide between them; `websocket_route` is the Flask-SocketIO spelling.
 */
export const flask: FrameworkModule = {
  name: "flask",
  evidence: ["flask"],
  entryPoints: {
    route: { kind: "http", httpMethod: "ANY" },
    api_route: { kind: "http", httpMethod: "ANY" },
    websocket: { kind: "http", httpMethod: "ANY" },
    websocket_route: { kind: "http", httpMethod: "ANY" },
    get: { kind: "http", httpMethod: "GET" },
    post: { kind: "http", httpMethod: "POST" },
    put: { kind: "http", httpMethod: "PUT" },
    delete: { kind: "http", httpMethod: "DELETE" },
    patch: { kind: "http", httpMethod: "PATCH" },
  },
};
