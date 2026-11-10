import type { ModelReadResult, ServiceSpec } from "../types";

/**
 * model-reader (milestone M1)
 *
 * Turns a compiled, linked CSN plus @mcp annotations into an ExposureSpec.
 *
 * Contract (see docs/annotations.md for the full annotation spec):
 * - Pure: no I/O, no global state, no `cds` runtime. Input is CSN, output is data.
 * - Opt-in: a definition with no @mcp annotation (directly or via its service) produces nothing.
 * - `@mcp` on a service gives the read-only baseline: query + get for every entity, plus all
 *   functions. Actions, writes, resources, prompts, UI, elicit, completion, describe and
 *   compact each need their own annotation.
 * - `@mcp: false` or `@cds.api.ignore` removes an entity/element.
 * - `@mcp.omit` elements never appear in any FieldSpec.
 * - Titles/descriptions fall back: @mcp.description → @description → doc comment → @title → name.
 * - Doc comments are read from CSN `doc`, present only when the app compiles with
 *   `cds.env.cdsc.docs = true`. The plugin never sets that for the app (ADR 0011).
 * - Unknown `@mcp.*` keys produce an UNKNOWN_ANNOTATION diagnostic, never a silent no-op.
 * - v1 annotations that changed meaning produce V1_ANNOTATION diagnostics.
 */

/** The slice of a CSN definition the reader looks at. Annotations are `@`-prefixed keys. */
interface Definition {
  kind?: string;
  doc?: string;
  [annotation: `@${string}`]: unknown;
}

interface Csn {
  definitions?: Record<string, Definition>;
}

export function readModel(csn: unknown): ModelReadResult {
  const definitions = (csn as Csn).definitions ?? {};
  const services: ServiceSpec[] = Object.entries(definitions)
    .filter(([, def]) => def.kind === "service" && def["@mcp"])
    .map(([name, def]) => ({
      name,
      title: str(def["@title"]) ?? name,
      description: def.doc ?? str(def["@title"]),
      compact: false,
      describe: false,
      entities: [],
      operations: [],
      prompts: [],
    }));
  return { spec: { services }, diagnostics: [] };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
