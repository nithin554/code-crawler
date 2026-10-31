import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedFile } from "../src/parser/language.js";
import { getLanguageConfig, listLanguageDescriptors } from "../src/parser/languages/index.js";
import { moduleResolver } from "../src/resolver/genericResolver.js";
import { javaResolver } from "../src/resolver/javaResolver.js";
import {
  capabilitiesOf,
  DEFAULT_RESOLVER,
  getResolver,
  listResolvers,
  resolveFileWith,
} from "../src/resolver/registry.js";
import type { TypeIndex } from "../src/resolver/types.js";

/**
 * The language descriptor is the single place that says what a language is:
 * extensions → grammar → resolver → frameworks → fixture. These tests hold the
 * table to that promise, so adding language #5 is a data change rather than an
 * edit scattered across existing language modules.
 */
describe("language descriptors", () => {
  const descriptors = listLanguageDescriptors();

  it("registers each language under its own name", () => {
    expect(descriptors.length).toBeGreaterThanOrEqual(3);
    for (const descriptor of descriptors) {
      expect(getLanguageConfig(descriptor.name)).toBe(descriptor);
    }
  });

  it("names a resolver that actually exists", () => {
    for (const descriptor of descriptors) {
      expect(
        getResolver(descriptor.resolver),
        `${descriptor.name} → ${descriptor.resolver}`
      ).toBeDefined();
    }
  });

  it("declares the frameworks its parser detects", () => {
    for (const descriptor of descriptors) {
      expect(descriptor.frameworks.length).toBeGreaterThan(0);
      expect(new Set(descriptor.frameworks).size).toBe(descriptor.frameworks.length);
    }
  });

  it("points at a conformance fixture that exists on disk", () => {
    for (const descriptor of descriptors) {
      const dir = path.join(__dirname, "fixtures", ...descriptor.fixture);
      expect(fs.existsSync(dir), `${descriptor.name}: ${dir}`).toBe(true);
    }
  });

  it("never claims the same extension for two languages", () => {
    const owners = new Map<string, string>();
    for (const descriptor of descriptors) {
      for (const extension of descriptor.extensions) {
        expect(owners.get(extension), `.${extension}`).toBeUndefined();
        owners.set(extension, descriptor.name);
      }
    }
  });
});

describe("resolver contract", () => {
  it("declares non-empty, unique capabilities per resolver", () => {
    for (const resolver of listResolvers()) {
      expect(resolver.capabilities.length).toBeGreaterThan(0);
      expect(new Set(resolver.capabilities).size).toBe(resolver.capabilities.length);
    }
  });

  it("distinguishes a typed language from a dynamic one", () => {
    expect(javaResolver.capabilities).toContain("declared-types");
    expect(javaResolver.capabilities).toContain("hierarchy");
    expect(moduleResolver.capabilities).not.toContain("declared-types");
    expect(moduleResolver.capabilities).toContain("module-exports");
  });

  it("routes each language to the resolver its descriptor names", () => {
    expect(getLanguageConfig("java")?.resolver).toBe(javaResolver.name);
    expect(getLanguageConfig("python")?.resolver).toBe(moduleResolver.name);
    expect(getLanguageConfig("typescript")?.resolver).toBe(moduleResolver.name);
  });

  it("falls back to the default resolver for an unknown name", () => {
    expect(DEFAULT_RESOLVER).toBe(moduleResolver.name);
    expect(capabilitiesOf("no-such-resolver")).toEqual(moduleResolver.capabilities);
  });

  it("resolves through the fallback instead of throwing on an unknown language", () => {
    // An unregistered resolver name must degrade to module resolution, so a
    // language that ships without a specialised resolver still produces edges.
    const empty: ParsedFile = {
      filePath: "src/empty.py",
      language: "python",
      packageName: null,
      imports: [],
      types: [],
      methods: [],
      fields: [],
      callSites: [],
      localsByMethod: new Map(),
      moduleId: "src.empty",
    };
    expect(resolveFileWith("no-such-resolver", empty, {} as TypeIndex)).toEqual([]);
    expect(resolveFileWith(moduleResolver.name, empty, {} as TypeIndex)).toEqual([]);
  });
});
