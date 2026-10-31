import type { LanguageConfig, LanguageDescriptor } from "../language.js";
import { javaConfig } from "./java.js";
import { pythonConfig } from "./python.js";
import { typescriptConfig } from "./typescript.js";

/**
 * The one table that defines what this project speaks. Each language declares
 * its own descriptor next to its parser (extensions → grammar → resolver →
 * frameworks → fixture), so adding a language is a new module plus a row here,
 * and never an edit to an existing language.
 */
const registry = new Map<string, LanguageDescriptor>([
  ["java", javaConfig],
  ["python", pythonConfig],
  ["typescript", typescriptConfig],
]);

export function getLanguageConfig(name: string): LanguageDescriptor | null {
  return registry.get(name.toLowerCase()) ?? null;
}

export function listLanguages(): string[] {
  return [...registry.keys()];
}

/** Every descriptor, in registration order. */
export function listLanguageDescriptors(): LanguageDescriptor[] {
  return [...registry.values()];
}

/** Preferred-name aliases that share a parser but cover a subset of extensions. */
const PREFERRED_ALIASES: Record<string, { language: string; extensions: string[] }> = {
  javascript: { language: "typescript", extensions: ["js", "jsx", "mjs", "cjs"] },
};

/**
 * Pick the language for a file path based on its extension. A preferred
 * language narrows the result to that language's extensions; it never makes
 * unrelated files (README.md, configs) parseable.
 */
export function languageForFile(filePath: string, preferred?: string): LanguageConfig | null {
  const lower = filePath.toLowerCase();
  const hasExtension = (extensions: string[]): boolean =>
    extensions.some((ext) => lower.endsWith(`.${ext}`));

  if (preferred) {
    const key = preferred.toLowerCase();
    const byName = getLanguageConfig(key);
    if (byName) return hasExtension(byName.extensions) ? byName : null;

    const alias = PREFERRED_ALIASES[key];
    if (alias) {
      const config = getLanguageConfig(alias.language);
      return config && hasExtension(alias.extensions) ? config : null;
    }
  }
  for (const config of registry.values()) {
    if (hasExtension(config.extensions)) return config;
  }
  return null;
}
