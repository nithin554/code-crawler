import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version advertised in the MCP handshake.
 *
 * Read from package.json at runtime rather than baked in at build time: the
 * release workflow applies the release version with `npm version` *after*
 * `npm run build`, so a build-time constant would always report the
 * pre-release version. package.json is always included in the published
 * tarball, and `../package.json` resolves to the package root from both
 * `src/` (dev, tsx) and `dist/` (installed), so no build step is needed.
 */

/** Reported when the manifest cannot be read or carries no usable version. */
export const VERSION_FALLBACK = "0.0.0";

const DEFAULT_MANIFEST = new URL("../package.json", import.meta.url);

/** Extract `version` from raw package.json text, falling back when unusable. */
export function versionFromManifest(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Malformed JSON is treated the same as a missing version.
  }
  return VERSION_FALLBACK;
}

export function readPackageVersion(manifestUrl: URL = DEFAULT_MANIFEST): string {
  try {
    return versionFromManifest(readFileSync(fileURLToPath(manifestUrl), "utf8"));
  } catch {
    return VERSION_FALLBACK;
  }
}

export const SERVER_VERSION = readPackageVersion();
