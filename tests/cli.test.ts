import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntrypoint } from "../src/index.js";

describe("CLI entrypoint detection", () => {
  const modulePath = path.resolve("dist/index.js");
  const moduleUrl = pathToFileURL(modulePath).href;

  it("detects the module when argv[1] is the absolute script path", () => {
    expect(isEntrypoint(modulePath, moduleUrl)).toBe(true);
  });

  it("detects the module when argv[1] is relative", () => {
    const relative = path.relative(process.cwd(), modulePath);
    expect(isEntrypoint(relative, moduleUrl)).toBe(true);
  });

  it("rejects a different script", () => {
    expect(isEntrypoint(path.resolve("dist/other.js"), moduleUrl)).toBe(false);
  });

  it("rejects a missing argv[1]", () => {
    expect(isEntrypoint(undefined, moduleUrl)).toBe(false);
  });
});
