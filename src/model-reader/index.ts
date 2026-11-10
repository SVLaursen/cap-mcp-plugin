import type {
  Diagnostic,
  EntityMode,
  EntitySpec,
  FieldSpec,
  ModelReadResult,
  OperationSpec,
  PromptSpec,
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
  notNull?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  enum?: Record<string, { val?: string | number }>;
  doc?: string;
  elements?: Record<string, Definition>;
  actions?: Record<string, Definition>;
  params?: Record<string, Definition>;
  drafts?: Definition;
  [annotation: `@${string}`]: unknown;
}

interface Csn {
  definitions?: Record<string, Definition>;
}

/** What every read step needs: the whole model, and somewhere to report problems. */
interface Context {
  definitions: Record<string, Definition>;
  diagnostics: Diagnostic[];
}

const ASSOCIATION = new Set(["cds.Association", "cds.Composition"]);
const BASELINE: readonly EntityMode[] = ["query", "get"];
const MODES: ReadonlySet<string> = new Set<EntityMode>([
  "query",
  "get",
  "create",
  "update",
  "delete",
]);

export function readModel(csn: unknown): ModelReadResult {
  const ctx: Context = { definitions: (csn as Csn).definitions ?? {}, diagnostics: [] };
  const services = Object.entries(ctx.definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name, def]) => readService(name, def, ctx))
    .filter((s): s is ServiceSpec => s !== undefined);
  return { spec: { services }, diagnostics: ctx.diagnostics };
}

function readService(service: string, def: Definition, ctx: Context): ServiceSpec | undefined {
  const optedIn = isOptedIn(def);
  const entities: EntitySpec[] = [];
  const operations: OperationSpec[] = [];

  for (const [name, member] of Object.entries(ctx.definitions)) {
    if (!name.startsWith(`${service}.`) || isExcluded(member)) continue;
    if (member.kind === "entity" && !isGenerated(name, member, ctx.definitions)) {
      if (optedIn || isOptedIn(member)) entities.push(readEntity(name, service, member, ctx));
      for (const [action, op] of Object.entries(member.actions ?? {})) {
        if (exposesOperation(op, optedIn)) {
          operations.push(readOperation(`${name}.${action}`, service, op, ctx, name));
        }
      }
    } else if (member.kind === "function" || member.kind === "action") {
      if (exposesOperation(member, optedIn)) {
        operations.push(readOperation(name, service, member, ctx));
      }
    }
  }

  if (!optedIn && entities.length === 0 && operations.length === 0) return undefined;
  return {
    name: service,
    title: title(service, def),
    description: describe(def),
    compact: def["@mcp.compact"] === true,
    describe: def["@mcp.describe"] === true,
    entities,
    operations,
    prompts: readPrompts(service, def),
  };
}

function readEntity(name: string, service: string, def: Definition, ctx: Context): EntitySpec {
  const elements = Object.entries(def.elements ?? {});
  const fields = elements
    .filter(([, el]) => !ASSOCIATION.has(el.type ?? "") && !isExcluded(el) && !isOmitted(el))
    .map(([field, el]) => readField(field, el, def.elements));
  return {
    name,
    service,
    title: title(name, def),
    description: describe(def),
    keys: fields.filter((f) => f.key),
    fields,
    modes: readModes(name, def, ctx),
    resource: def["@mcp.resource"] === true,
    // Linked CSN gives draft roots and the compositions inside them a `drafts` entity.
    draft: def["@odata.draft.enabled"] === true || def.drafts !== undefined,
    deepInsert: elements
      .filter(([, el]) => el.type === "cds.Composition" && el["@mcp.deepInsert"] === true)
      .map(([element]) => element),
    searchable: false,
  };
}

/** Baseline query + get, plus whatever @mcp.wrap.modes lists. Unknown modes are reported. */
function readModes(name: string, def: Definition, ctx: Context): ReadonlySet<EntityMode> {
  const listed = def["@mcp.wrap.modes"];
  if (listed === undefined) return new Set(BASELINE);
  const values: unknown[] = Array.isArray(listed) ? listed : [listed];
  const modes = new Set<EntityMode>(BASELINE);
  for (const value of values) {
    if (typeof value === "string" && MODES.has(value)) modes.add(value as EntityMode);
    else {
      invalid(
        ctx,
        name,
        `@mcp.wrap.modes: unknown mode ${JSON.stringify(value)} (allowed: create, update, delete)`,
      );
    }
  }
  return modes;
}

function readOperation(
  name: string,
  service: string,
  def: Definition,
  ctx: Context,
  boundTo?: string,
): OperationSpec {
  return {
    name,
    service,
    kind: def.kind === "function" ? "function" : "action",
    title: title(name, def),
    boundTo,
    description: describe(def),
    params: Object.entries(def.params ?? {}).map(([param, p]) => readField(param, p)),
    elicit: strings(def["@mcp.elicit"]),
    ui: readUi(name, def, ctx),
  };
}

/** MCP Apps UI resources live under ui:// (issue #133); anything else is a mistake. */
function readUi(name: string, def: Definition, ctx: Context): string | undefined {
  const ui = def["@mcp.ui"];
  if (ui === undefined) return undefined;
  if (typeof ui === "string" && ui.startsWith("ui://")) return ui;
  invalid(ctx, name, `@mcp.ui must be a ui:// resource URI, got ${JSON.stringify(ui)}`);
  return undefined;
}

function readPrompts(service: string, def: Definition): PromptSpec[] {
  const prompts = def["@mcp.prompts"];
  if (!Array.isArray(prompts)) return [];
  return prompts.map((prompt: Record<string, unknown>) => ({
    name: str(prompt.name) ?? "",
    service,
    title: str(prompt.title),
    description: str(prompt.description),
    template: str(prompt.template) ?? "",
    role: prompt.role === "assistant" ? "assistant" : "user",
    inputs: Array.isArray(prompt.inputs)
      ? prompt.inputs.map((input: Record<string, unknown>) => ({
          key: str(input.key) ?? "",
          type: str(input.type) ?? "",
        }))
      : [],
  }));
}

/**
 * One element or parameter as the agent sees it. Node.js-flavoured CSN has already resolved
 * named types and `Entity:element` references to builtins, with enums inlined.
 * `siblings` are the other elements of the same entity, to find a foreign key's association.
 */
function readField(
  name: string,
  def: Definition,
  siblings: Record<string, Definition> = {},
): FieldSpec {
  const association = str(def["@odata.foreignKey4"]);
  const range = def["@assert.range"];
  return {
    name,
    cdsType: def.type ?? "",
    key: def.key === true,
    description: str(def["@mcp.hint"]) ?? str(def["@description"]) ?? def.doc,
    mandatory: def.notNull === true || def["@mandatory"] === true,
    readonly:
      def["@readonly"] === true ||
      def["@Core.Computed"] === true ||
      def["@cds.on.insert"] !== undefined ||
      def["@cds.on.update"] !== undefined,
    enum: def.enum && Object.entries(def.enum).map(([symbol, { val }]) => val ?? symbol),
    length: def.length,
    precision: def.precision,
    scale: def.scale,
    range: Array.isArray(range) ? [bound(range[0]), bound(range[1])] : undefined,
    target: association ? siblings[association]?.target : undefined,
    completion: def["@mcp.completion"] === true,
  };
}

/** An @assert.range bound; `_` (open) compiles to `{ "=": "_" }`. */
function bound(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function invalid(ctx: Context, target: string, message: string): void {
  ctx.diagnostics.push({ level: "error", code: "INVALID_ANNOTATION_VALUE", target, message });
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

function title(name: string, def: Definition): string {
  return str(def["@mcp.name"]) ?? str(def["@title"]) ?? name;
}

function describe(def: Definition): string | undefined {
  return str(def["@mcp.description"]) ?? str(def["@description"]) ?? def.doc ?? str(def["@title"]);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
