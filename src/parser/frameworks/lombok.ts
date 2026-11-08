import type { FrameworkModule } from "./types.js";

/**
 * Lombok constructor generation.
 *
 * The constructor is real at runtime but absent from the AST: an annotation
 * processor writes it during compilation. `@AllArgsConstructor` takes every
 * instance field; `@RequiredArgsConstructor` takes only the ones the type
 * cannot leave null — `final` and `@NonNull` fields without an initialiser.
 */
export const lombok: FrameworkModule = {
  name: "lombok",
  evidence: ["lombok."],
  constructors: { AllArgsConstructor: "all", RequiredArgsConstructor: "required" },
};
