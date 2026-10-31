import type { FrameworkModule } from "./types.js";

/** Fastify declares evidence only; the receiver heuristic lives in the parser. */
export const fastify: FrameworkModule = {
  name: "fastify",
  evidence: ["fastify"],
};
