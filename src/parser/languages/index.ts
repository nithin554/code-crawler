import type { LanguageConfig } from "../language.js";
import { javaConfig } from "./java.js";

/**
 * Registry of supported languages. Adding a language means:
 *   1. implement a LanguageConfig in `./<lang>.ts`
 *   2. register it here
 *   3. implement a resolver keyed by the same name in `src/resolver/`
 */

const registry = new Map<string, LanguageConfig>([
  ["java", javaConfig],
]);

export function getLanguageConfig(name: string): LanguageConfig | null {
  return registry.get(name.toLowerCase()) ?? null;
}

export function listLanguages(): string[] {
  return [...registry.keys()];
}

/** Pick the language for a file path based on its extension. */
export function languageForFile(filePath: string, preferred?: string): LanguageConfig | null {
  const lower = filePath.toLowerCase();
  if (preferred) {
    const byName = getLanguageConfig(preferred);
    if (byName) return byName;
  }
  for (const config of registry.values()) {
    if (config.extensions.some((ext) => lower.endsWith(`.${ext}`))) return config;
  }
  return null;
}