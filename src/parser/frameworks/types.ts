import type { EntryPointInfo } from "../language.js";

/** What a framework annotation implies for the symbol it is attached to. */
export interface EntryPointSpec {
  kind: EntryPointInfo["kind"];
  /** HTTP verb the annotation implies; `ANY` when the annotation is verb-agnostic. */
  httpMethod?: string;
}

/**
 * One framework's conventions.
 *
 * Detection is data: a parser asks the registry what an annotation means instead
 * of carrying its own table, so supporting a new framework is a new file here
 * rather than an edit to every language that can host it.
 */
export interface FrameworkModule {
  /** Registry key; also the default label for injections attributed to it. */
  name: string;
  /**
   * Import prefixes that evidence this framework in a file. Used to break ties
   * when two frameworks claim the same annotation (e.g. `Inject`).
   */
  evidence?: string[];
  /** Annotations/decorators that make the annotated method a root. */
  entryPoints?: Record<string, EntryPointSpec>;
  /** Qualified-name prefixes that also mark a root, e.g. pytest's `mark.`. */
  qualifiedPrefixes?: Record<string, EntryPointSpec>;
  /** Annotations that request injection: name -> label (defaults to `name`). */
  injections?: Record<string, string | true>;
  /** Annotations that mark a class as container-managed. */
  injectables?: string[];
  /** Annotations that mark an aspect class. */
  aspects?: string[];
  /** Advice annotations: name -> advice kind (`before`, `around`, ...). */
  advice?: Record<string, string>;
  /** Raw markers inside a parameter list -> injection label. */
  paramMarkers?: Record<string, string>;
}

/**
 * The framework conventions a single file is judged against, ordered by how
 * much evidence supports them: imports first, then the language descriptor's
 * declared frameworks, then everything registered.
 */
export interface FrameworkScope {
  /** Modules evidenced by the file's own imports. */
  evidenced: FrameworkModule[];
  /** Modules the language descriptor declares, in declaration order. */
  preferred: FrameworkModule[];
  /** Every registered module. */
  all: FrameworkModule[];
  /** Compare annotation names case-insensitively (Python lower-cases decorators). */
  caseInsensitive: boolean;
}
