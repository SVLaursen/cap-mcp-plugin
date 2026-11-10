import type {
  EntityMode,
  EntitySpec,
  FieldSpec,
  ModelReadResult,
  OperationSpec,
  ServiceSpec,
} from "../types";

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
  type?: string;
  target?: string;
  key?: boolean;
  doc?: string;
  elements?: Record<string, Definition>;
  actions?: Record<string, Definition>;
  [annotation: `@${string}`]: unknown;
}

interface Csn {
  definitions?: Record<string, Definition>;
}

const ASSOCIATION = new Set(["cds.Association", "cds.Composition"]);
const BASELINE: ReadonlySet<EntityMode> = new Set(["query", "get"]);

export function readModel(csn: unknown): ModelReadResult {
  const definitions = (csn as Csn).definitions ?? {};
  const services = Object.entries(definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name, def]) => readService(name, def, definitions))
    .filter((s): s is ServiceSpec => s !== undefined);
  return { spec: { services }, diagnostics: [] };
}

function readService(
  service: string,
  def: Definition,
  definitions: Record<string, Definition>,
): ServiceSpec | undefined {
  const optedIn = isOptedIn(def);
  const entities: EntitySpec[] = [];
  const operations: OperationSpec[] = [];

  for (const [name, member] of Object.entries(definitions)) {
    if (!name.startsWith(`${service}.`) || isExcluded(member)) continue;
    if (member.kind === "entity" && !isGenerated(name, member, definitions)) {
      if (optedIn || isOptedIn(member)) entities.push(readEntity(name, service, member));
      for (const [action, op] of Object.entries(member.actions ?? {})) {
        if (exposesOperation(op, optedIn)) {
          operations.push(readOperation(`${name}.${action}`, service, op, name));
        }
      }
    } else if (member.kind === "function" || member.kind === "action") {
      if (exposesOperation(member, optedIn)) operations.push(readOperation(name, service, member));
    }
  }

  if (!optedIn && entities.length === 0 && operations.length === 0) return undefined;
  return {
    name: service,
    title: str(def["@title"]) ?? service,
    description: describe(def),
    compact: false,
    describe: false,
    entities,
    operations,
    prompts: [],
  };
}

function readEntity(name: string, service: string, def: Definition): EntitySpec {
  const fields = Object.entries(def.elements ?? {})
    .filter(([, el]) => !ASSOCIATION.has(el.type ?? "") && !isExcluded(el) && !isOmitted(el))
    .map(([field, el]) => readField(field, el));
  return {
    name,
    service,
    title: str(def["@title"]) ?? name,
    description: describe(def),
    keys: fields.filter((f) => f.key),
    fields,
    modes: BASELINE,
    resource: false,
    draft: false,
    deepInsert: [],
    searchable: false,
  };
}

function readOperation(
  name: string,
  service: string,
  def: Definition,
  boundTo?: string,
): OperationSpec {
  return {
    name,
    service,
    kind: def.kind === "function" ? "function" : "action",
    boundTo,
    description: describe(def),
    params: [],
  };
}

function readField(name: string, def: Definition): FieldSpec {
  return {
    name,
    cdsType: def.type ?? "",
    key: def.key === true,
    mandatory: false,
    readonly: false,
    completion: false,
  };
}

/** Actions need their own @mcp; functions come with the service baseline (ADR 0004). */
function exposesOperation(op: Definition, serviceOptedIn: boolean): boolean {
  if (isExcluded(op)) return false;
  return isOptedIn(op) || (op.kind === "function" && serviceOptedIn);
}

function isOptedIn(def: Definition): boolean {
  return def["@mcp"] === true;
}

/** CAP propagates @mcp.omit to generated foreign keys and through projections. */
function isOmitted(element: Definition): boolean {
  return element["@mcp.omit"] === true;
}

function isExcluded(def: Definition): boolean {
  return def["@mcp"] === false || def["@cds.api.ignore"] === true;
}

/** Entities CAP adds on its own (localized texts, draft bookkeeping) are never baseline. */
function isGenerated(
  name: string,
  def: Definition,
  definitions: Record<string, Definition>,
): boolean {
  if (def["@cds.autoexposed"] === true || name.endsWith(".DraftAdministrativeData")) return true;
  const parent = name.endsWith(".texts") ? definitions[name.slice(0, -".texts".length)] : undefined;
  return parent?.elements?.texts?.target === name;
}

function describe(def: Definition): string | undefined {
  return def.doc ?? str(def["@title"]);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
