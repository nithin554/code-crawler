import type { FrameworkModule } from "./types.js";

/**
 * Express declares evidence only: route registration is detected from call
 * receivers (`app.get(...)`), which is a syntactic heuristic the parser owns.
 */
export const express: FrameworkModule = {
  name: "express",
  evidence: ["express"],
};
