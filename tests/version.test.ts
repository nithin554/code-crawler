import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPackageVersion,
  SERVER_VERSION,
  VERSION_FALLBACK,
  versionFromManifest,
} from "../src/version.js";

const manifestPath = path.join(__dirname, "..", "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: string };

describe("server version", () => {
  it("reports the version published in package.json", () => {
    // Guards the MCP handshake against the hardcoded literal that used to sit
    // in server.ts: the advertised version must track the real release.
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  it("extracts the version from a manifest", () => {
    expect(versionFromManifest('{"name":"x","version":"1.2.3"}')).toBe("1.2.3");
  });

  it("falls back when the manifest carries no usable version", () => {
    expect(versionFromManifest("{}")).toBe(VERSION_FALLBACK);
    expect(versionFromManifest('{"version":""}')).toBe(VERSION_FALLBACK);
    expect(versionFromManifest('{"version":42}')).toBe(VERSION_FALLBACK);
    expect(versionFromManifest('{"version":null}')).toBe(VERSION_FALLBACK);
  });

  it("falls back for JSON that is not an object", () => {
    expect(versionFromManifest("null")).toBe(VERSION_FALLBACK);
    expect(versionFromManifest('"1.2.3"')).toBe(VERSION_FALLBACK);
    expect(versionFromManifest("42")).toBe(VERSION_FALLBACK);
  });

  it("falls back for malformed JSON", () => {
    expect(versionFromManifest("{ not json")).toBe(VERSION_FALLBACK);
    expect(versionFromManifest("")).toBe(VERSION_FALLBACK);
  });

  it("reads an explicitly supplied manifest", () => {
    expect(readPackageVersion(new URL("../package.json", import.meta.url))).toBe(manifest.version);
  });

  it("falls back when the manifest cannot be read", () => {
    const missing = new URL("./no-such-directory/package.json", import.meta.url);
    expect(readPackageVersion(missing)).toBe(VERSION_FALLBACK);
  });
});
