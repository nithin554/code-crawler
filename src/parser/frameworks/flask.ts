import type { FrameworkModule } from "./types.js";

/** Flask: route decorators that accept any verb, plus `add_url_rule`. */
export const flask: FrameworkModule = {
  name: "flask",
  evidence: ["flask"],
  entryPoints: {
    route: { kind: "http", httpMethod: "ANY" },
    api_route: { kind: "http", httpMethod: "ANY" },
    websocket: { kind: "http", httpMethod: "ANY" },
    websocket_route: { kind: "http", httpMethod: "ANY" },
  },
};
