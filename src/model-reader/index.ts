import type {
  Diagnostic,
  EntityMode,
  EntitySpec,
  FieldSpec,
  ModelReadResult,
  OperationSpec,
  PromptSpec,
  ReturnSpec,
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
  returns?: Definition;
  items?: Definition;
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

/** Elements CAP adds to draft-enabled entities. The executor drives drafts; agents never see them. */
const DRAFT_ELEMENTS = new Set([
  "IsActiveEntity",
  "HasActiveEntity",
  "HasDraftEntity",
  "DraftAdministrativeData",
  "DraftAdministrativeData_DraftUUID",
  "DraftMessages",
  "SiblingEntity",
]);
const BASELINE: readonly EntityMode[] = ["query", "get"];
/** Modes that act on one record, so they need its keys. */
const ADDRESSED: ReadonlySet<string> = new Set(["get", "update", "delete"]);
const MODES: ReadonlySet<string> = new Set<EntityMode>([
  "query",
  "get",
  "create",
  "update",
  "delete",
]);

/** Every annotation key v2 understands. Anything else under `@mcp.` is a diagnostic. */
const KNOWN = new Set([
  "@mcp",
  "@mcp.name",
  "@mcp.description",
  "@mcp.hint",
  "@mcp.omit",
  "@mcp.wrap.modes",
  "@mcp.deepInsert",
  "@mcp.resource",
  "@mcp.prompts",
  "@mcp.ui",
  "@mcp.elicit",
  "@mcp.completion",
  "@mcp.describe",
  "@mcp.compact",
]);

/** v1 annotations that v2 dropped or renamed, with what to use instead (docs/annotations.md). */
const V1: Record<string, string> = {
  "@mcp.wrap.tools": "query/get tools are the default for an exposed entity; use @mcp",
  "@mcp.tool": "use @mcp on the action; functions are baseline under @mcp on the service",
  "@mcp.usePrimaryKey": "dropped; keys are always the entity keys",
};

export function readModel(csn: unknown): ModelReadResult {
  const ctx: Context = { definitions: (csn as Csn).definitions ?? {}, diagnostics: [] };
  checkAnnotations(ctx);
  const services = Object.entries(ctx.definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name, def]) => readService(name, def, ctx))
    .filter((s): s is ServiceSpec => s !== undefined);
  return { spec: { services }, diagnostics: ctx.diagnostics };
}

function readService(service: string, def: Definition, ctx: Context): ServiceSpec | undefined {
  if (isExcluded(def)) return undefined;
  const optedIn = isOptedIn(def);
  const entities: EntitySpec[] = [];
  const operations: OperationSpec[] = [];

  for (const [name, member] of Object.entries(ctx.definitions)) {
    if (!name.startsWith(`${service}.`) || isExcluded(member)) continue;
    if (member.kind === "entity") {
      // CAP-generated entities are not baseline, but an explicit @mcp on one still counts.
      const generated = isGenerated(name, member, ctx.definitions);
      if (generated && !isOptedIn(member)) continue;
      if (optedIn || isOptedIn(member)) entities.push(readEntity(name, service, member, ctx));
      const addressable = isAddressable(member);
      for (const [action, op] of Object.entries(member.actions ?? {})) {
        if (!exposesOperation(op, optedIn)) continue;
        if (!addressable) {
          ctx.diagnostics.push({
            level: "error",
            code: "BOUND_OPERATION_WITHOUT_KEYS",
            target: `${name}.${action}`,
            message: `${name} has no exposed keys, so its bound operation ${action} cannot address an instance; not exposed`,
          });
          continue;
        }
        operations.push(readOperation(`${name}.${action}`, service, op, ctx, name));
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
    requires: roles(def),
    compact: def["@mcp.compact"] === true,
    describe: def["@mcp.describe"] === true,
    entities,
    operations,
    prompts: readPrompts(service, def),
  };
}

function readEntity(name: string, service: string, def: Definition, ctx: Context): EntitySpec {
  const elements = Object.entries(def.elements ?? {});
  for (const [element, el] of elements) {
    if (el.key && isOmitted(el)) {
      ctx.diagnostics.push({
        level: "warn",
        code: "OMITTED_KEY",
        target: `${name}:${element}`,
        message: `@mcp.omit on key ${element}: records of ${name} cannot be addressed, so get, update, delete and bound operations are not offered`,
      });
    }
  }
  const draft = def["@odata.draft.enabled"] === true || def.drafts !== undefined;
  const fields = readFields(def.elements).filter((f) => !draft || !DRAFT_ELEMENTS.has(f.name));
  return {
    name,
    service,
    title: title(name, def),
    description: describe(def),
    keys: fields.filter((f) => f.key),
    fields,
    modes: readModes(name, def, ctx, isAddressable(def)),
    requires: roles(def),
    resource: def["@mcp.resource"] === true,
    // Linked CSN gives draft roots and the compositions inside them a `drafts` entity.
    draft,
    deepInsert: elements
      .filter(([, el]) => el.type === "cds.Composition" && el["@mcp.deepInsert"] === true)
      .map(([element, el]) => ({ element, target: el.target ?? "" })),
    searchable: false,
  };
}

/**
 * Baseline query + get, plus whatever @mcp.wrap.modes lists. Unknown modes are reported.
 * Without an address (see isAddressable) only query and create make sense.
 */
function readModes(
  name: string,
  def: Definition,
  ctx: Context,
  addressable: boolean,
): ReadonlySet<EntityMode> {
  const modes = new Set<EntityMode>(addressable ? BASELINE : ["query"]);
  const listed = def["@mcp.wrap.modes"];
  if (listed === undefined) return modes;
  const refused: string[] = [];
  for (const value of Array.isArray(listed) ? listed : [listed]) {
    if (typeof value !== "string" || !MODES.has(value)) {
      invalid(
        ctx,
        name,
        `@mcp.wrap.modes: unknown mode ${JSON.stringify(value)} (allowed: create, update, delete)`,
      );
    } else if (!addressable && ADDRESSED.has(value)) refused.push(value);
    else modes.add(value as EntityMode);
  }
  if (refused.length) {
    invalid(
      ctx,
      name,
      `@mcp.wrap.modes: ${refused.join(", ")} need a record address, but ${name} has no exposed keys`,
    );
  }
  return modes;
}

/** An entity's records can be addressed when it has keys and none of them is @mcp.omit. */
function isAddressable(def: Definition): boolean {
  const keys = Object.values(def.elements ?? {}).filter((el) => el.key);
  return keys.length > 0 && !keys.some(isOmitted);
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
    returns: readReturns(def.returns, ctx),
    requires: roles(def),
    elicit: strings(def["@mcp.elicit"]),
    ui: readUi(name, def, ctx),
  };
}

/** The scalar, non-ignored, non-omitted elements an agent may see. */
function readFields(elements: Record<string, Definition> = {}): FieldSpec[] {
  return Object.entries(elements)
    .filter(([, el]) => !ASSOCIATION.has(el.type ?? "") && !isExcluded(el) && !isOmitted(el))
    .map(([field, el]) => readField(field, el, elements));
}

/** `returns X`, `returns array of X`, with X a builtin, an entity or an inline structure. */
function readReturns(returns: Definition | undefined, ctx: Context): ReturnSpec | undefined {
  if (!returns) return undefined;
  const many = returns.items !== undefined;
  const type = returns.items ?? returns;
  const entity = type.type ? ctx.definitions[type.type] : undefined;
  if (entity?.kind === "entity" && type.type) {
    return { many, entity: type.type, fields: readFields(entity.elements) };
  }
  if (type.elements) return { many, fields: readFields(type.elements) };
  return { many, scalar: readField("value", type) };
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

/**
 * Report unknown and v1 `@mcp.*` keys anywhere in the model, exposed or not, so a typo is never
 * a silent no-op. Targets: `Def`, `Def:element`, `Def.boundOp`, `Op:param`.
 */
function checkAnnotations(ctx: Context): void {
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "entity" && isGenerated(name, def, ctx.definitions)) continue;
    checkKeys(ctx, name, def);
    for (const [element, el] of Object.entries(def.elements ?? {})) {
      checkKeys(ctx, `${name}:${element}`, el);
    }
    // Only entities have bound actions; a linked service also lists its unbound ones here.
    const bound = def.kind === "entity" ? def.actions : undefined;
    for (const [action, op] of Object.entries(bound ?? {})) {
      checkKeys(ctx, `${name}.${action}`, op);
      for (const [param, p] of Object.entries(op.params ?? {})) {
        checkKeys(ctx, `${name}.${action}:${param}`, p);
      }
    }
    for (const [param, p] of Object.entries(def.params ?? {})) {
      checkKeys(ctx, `${name}:${param}`, p);
    }
  }
}

function checkKeys(ctx: Context, target: string, def: Definition): void {
  for (const key of Object.keys(def)) {
    if (key !== "@mcp" && !key.startsWith("@mcp.")) continue;
    const v1 = V1[key];
    if (v1) {
      ctx.diagnostics.push({
        level: "warn",
        code: "V1_ANNOTATION",
        target,
        message: `${key} is a v1 annotation: ${v1}`,
      });
    } else if (key === "@mcp.resource" && Array.isArray(def[key])) {
      ctx.diagnostics.push({
        level: "warn",
        code: "V1_ANNOTATION",
        target,
        message:
          "@mcp.resource with a list of query options is v1; use the query tool. In v2, @mcp.resource means single records by key",
      });
    } else if (!KNOWN.has(key)) {
      ctx.diagnostics.push({
        level: "warn",
        code: "UNKNOWN_ANNOTATION",
        target,
        message: `Unknown annotation ${key} on ${target}; it has no effect`,
      });
    }
  }
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

/** @requires: 'role' or ['a', 'b']. Only for hiding tools; CAP enforces it on every request. */
function roles(def: Definition): string[] | undefined {
  const requires = def["@requires"];
  return typeof requires === "string" ? [requires] : strings(requires);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
