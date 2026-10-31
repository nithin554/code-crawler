import type { FrameworkModule } from "./types.js";

/**
 * TypeScript DI containers: no marker annotation, so a parameter is attributed
 * here only through the parser's constructor-injection default.
 */
export const tsDi: FrameworkModule = {
  name: "ts-di",
  evidence: ["tsyringe", "inversify", "typedi", "@nestjs/"],
};
