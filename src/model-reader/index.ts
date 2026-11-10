import type {
  Diagnostic,
  EntityMode,
  EntitySpec,
  FieldSpec,
  GrantSpec,
  ModelReadResult,
  OperationSpec,
  PromptSpec,
  ReturnSpec,
  ServiceSpec,
} from "../types";
import { isMappedType } from "../schema-mapper";

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
  virtual?: boolean;
  value?: unknown;
  cardinality?: { max?: number | string };
  projection?: { from?: { ref?: unknown[] } };
  query?: { SELECT?: { from?: { ref?: unknown[] } } };
  on?: unknown;
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
  checkUnused(ctx, services);
  return { spec: { services }, diagnostics: ctx.diagnostics };
}

/**
 * Feature annotations (@mcp.*) on a service, entity or operation that ends up not exposed have
 * no effect; say so instead of failing silently. Definitions excluded on purpose (@mcp: false,
 * @cds.api.ignore) and ones already reported as errors are skipped.
 */
function checkUnused(ctx: Context, services: ServiceSpec[]): void {
  const exposed = new Set(
    services.flatMap((s) => [
      s.name,
      ...s.entities.map((e) => e.name),
      ...s.operations.map((o) => o.name),
    ]),
  );
  const reported = new Set(ctx.diagnostics.filter((d) => d.level === "error").map((d) => d.target));
  const report = (target: string, def: Definition) => {
    if (exposed.has(target) || reported.has(target) || isExcluded(def)) return;
    // Annotations CAP copied from another layer are meant for the MCP services that project
    // it; in other services they are expected to do nothing.
    const keys = Object.keys(def).filter(
      (key) =>
        key.startsWith("@mcp.") && KNOWN.has(key) && !isCopied(def, key as `@${string}`, ctx),
    );
    if (keys.length === 0) return;
    ctx.diagnostics.push({
      level: "warn",
      code: "UNUSED_ANNOTATION",
      target,
      message: `${keys.join(", ")} on ${target} has no effect: ${target} is not exposed over MCP`,
    });
  };
  const serviceNames = Object.entries(ctx.definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name]) => name);
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "service") {
      report(name, def);
      continue;
    }
    const service = serviceNames.find((s) => name.startsWith(`${s}.`));
    if (!service || isExcluded(ctx.definitions[service] ?? {})) continue;
    if (def.kind === "function" || def.kind === "action") report(name, def);
    if (def.kind !== "entity" || isExcluded(def)) continue;
    if (isGenerated(name, def, ctx.definitions) && !isOptedIn(def)) continue;
    report(name, def);
    for (const [action, op] of Object.entries(def.actions ?? {})) report(`${name}.${action}`, op);
  }
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
      if (generated && !(isOptedIn(member) && !isCopied(member, "@mcp", ctx))) continue;
      // Outside an @mcp service, only an @mcp written here counts, not one CAP copied in.
      const ownOptIn = isOptedIn(member) && !isCopied(member, "@mcp", ctx);
      if (optedIn || ownOptIn) entities.push(readEntity(name, service, member, ctx));
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
        const keys = Object.entries(member.elements ?? {}).filter(([, el]) => el.key);
        const clash = keys.find(([key]) => key in (op.params ?? {}));
        if (clash) {
          ctx.diagnostics.push({
            level: "error",
            code: "PARAMETER_SHADOWS_KEY",
            target: `${name}.${action}:${clash[0]}`,
            message: `Parameter ${clash[0]} of ${action} has the name of a key of ${name}; the tool could not tell them apart. Not exposed`,
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
    requires: roles(def) ?? restrictRoles(def),
    compact: def["@mcp.compact"] === true,
    describe: def["@mcp.describe"] === true,
    entities,
    operations,
    prompts: readPrompts(service, def, ctx),
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
  checkTypes(ctx, name, fields);
  for (const [element, el] of Object.entries(def.elements ?? {})) {
    // CAP copies the annotation onto a managed association's foreign keys; report the element once.
    const foreignKey = el["@odata.foreignKey4"] !== undefined;
    if (el["@mcp.deepInsert"] !== undefined && el.type !== "cds.Composition" && !foreignKey) {
      invalid(ctx, `${name}:${element}`, `@mcp.deepInsert only applies to compositions`);
    }
  }
  return {
    name,
    service,
    title: title(name, def),
    description: describe(def),
    keys: fields.filter((f) => f.key),
    fields,
    modes: readModes(name, def, ctx, isAddressable(def)),
    ...entityAccess(def, ctx),
    resource: def["@mcp.resource"] === true,
    // Linked CSN gives draft roots and the compositions inside them a `drafts` entity.
    draft,
    deepInsert: elements
      .filter(([, el]) => el.type === "cds.Composition" && el["@mcp.deepInsert"] === true)
      .map(([element, el]) => ({
        element,
        target: el.target ?? "",
        many: el.cardinality?.max === "*",
        backlink: backlinkOf(element, el.on),
      })),
    search: searchColumns(def, ctx),
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

/**
 * The columns `q` may search, following CAP's @cds.search rules (@cap-js/db-service
 * lib/search.js) but never an @mcp.omit field, on this entity or behind an association.
 */
function searchColumns(def: Definition, ctx: Context, depth = 0): string[] {
  const elements = def.elements ?? {};
  const listed = new Map<string, unknown>();
  for (const key of Object.keys(def)) {
    if (key.startsWith("@cds.search."))
      listed.set(key.slice("@cds.search.".length), def[key as `@${string}`]);
  }
  const visible = (el: Definition | undefined): el is Definition =>
    !!el && !el.virtual && !isExcluded(el) && !isOmitted(el);
  const chosen = [...listed].filter(([, on]) => on);
  if (chosen.length === 0) {
    return Object.entries(elements)
      .filter(([, el]) => visible(el) && el.type === "cds.String" && el.value === undefined)
      .filter(([name]) => listed.get(name) === undefined && !DRAFT_ELEMENTS.has(name))
      .map(([name]) => name);
  }
  return chosen.flatMap(([path]) => {
    const [head = "", ...rest] = path.split(".");
    const el = elements[head];
    if (!visible(el)) return [];
    if (!ASSOCIATION.has(el.type ?? "")) return rest.length ? [] : [head];
    const target = el.target ? ctx.definitions[el.target] : undefined;
    if (!target || depth > 0) return [];
    const nested = rest.length
      ? searchColumns(
          { elements: target.elements, [`@cds.search.${rest.join(".")}`]: true },
          ctx,
          depth + 1,
        )
      : searchColumns(target, ctx, depth + 1);
    return nested.map((column) => `${head}.${column}`);
  });
}

/** The entity a projection or view selects from, if any. */
function sourceOf(def: Definition, ctx: Context): Definition | undefined {
  const from = def.projection?.from ?? def.query?.SELECT?.from;
  const ref = from?.ref?.[0];
  return typeof ref === "string" ? ctx.definitions[ref] : undefined;
}

/**
 * True when `key` has the same value on the entity this one projects: CAP copied it here, or it
 * was written again with the same value (the compiled model cannot tell these apart).
 */
function isCopied(def: Definition, key: `@${string}`, ctx: Context): boolean {
  const source = sourceOf(def, ctx);
  return !!source && JSON.stringify(source[key]) === JSON.stringify(def[key]);
}

/** `on items.up_ = $self` → "up_": the child's association that CAP fills on deep insert. */
function backlinkOf(element: string, on: unknown): string | undefined {
  if (!Array.isArray(on)) return undefined;
  for (const term of on) {
    const ref = (term as { ref?: unknown[] })?.ref;
    if (Array.isArray(ref) && ref.length === 2 && ref[0] === element) return String(ref[1]);
  }
  return undefined;
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
  const params = Object.entries(def.params ?? {})
    .filter(([, p]) => (p.items ?? p).type !== "$self") // CAP's binding parameter
    .map(([param, p]) => readField(param, p));
  checkTypes(ctx, name, params);
  return {
    name,
    service,
    kind: def.kind === "function" ? "function" : "action",
    title: title(name, def),
    boundTo,
    description: describe(def),
    params,
    returns: readReturns(def.returns, ctx),
    requires: roles(def),
    restrict: grants(def)?.map(({ to }) => ({ grant: name.slice(name.lastIndexOf(".") + 1), to })),
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
    const draft = entity["@odata.draft.enabled"] === true || entity.drafts !== undefined;
    const fields = readFields(entity.elements).filter((f) => !draft || !DRAFT_ELEMENTS.has(f.name));
    return { many, entity: type.type, fields };
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

function readPrompts(service: string, def: Definition, ctx: Context): PromptSpec[] {
  const prompts = def["@mcp.prompts"];
  if (prompts === undefined) return [];
  if (!Array.isArray(prompts)) {
    invalid(ctx, service, "@mcp.prompts must be a list of prompt objects");
    return [];
  }
  return prompts.flatMap((prompt: Record<string, unknown>) => {
    const name = str(prompt.name);
    const template = str(prompt.template);
    const role = prompt.role ?? "user";
    if (!name || !template || (role !== "user" && role !== "assistant")) {
      invalid(
        ctx,
        service,
        `@mcp.prompts entry ${JSON.stringify(prompt.name ?? null)} needs a name, a template and role 'user' or 'assistant'`,
      );
      return [];
    }
    return [
      {
        name,
        service,
        title: str(prompt.title),
        description: str(prompt.description),
        template,
        role,
        inputs: Array.isArray(prompt.inputs)
          ? prompt.inputs.map((input: Record<string, unknown>) => ({
              key: str(input.key) ?? "",
              type: str(input.type) ?? "",
            }))
          : [],
      },
    ];
  });
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
  if (def.items) {
    const item = readField(name, def.items);
    const mandatory = def.notNull === true || def["@mandatory"] === true;
    return { ...item, many: true, mandatory, description: describeElement(def) };
  }
  const association = str(def["@odata.foreignKey4"]);
  const range = def["@assert.range"];
  return {
    name,
    cdsType: def.type ?? "",
    key: def.key === true,
    description: describeElement(def),
    mandatory: def.notNull === true || def["@mandatory"] === true,
    notNull: def.notNull === true ? true : undefined,
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
    association,
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

function checkTypes(ctx: Context, owner: string, fields: FieldSpec[]): void {
  for (const field of fields) {
    if (isMappedType(field.cdsType)) continue;
    ctx.diagnostics.push({
      level: "warn",
      code: "UNSUPPORTED_TYPE",
      target: `${owner}:${field.name}`,
      message: `${field.cdsType || "this type"} has no JSON Schema mapping; agents see ${field.name} as any value`,
    });
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

function describeElement(def: Definition): string | undefined {
  return str(def["@mcp.hint"]) ?? str(def["@description"]) ?? def.doc;
}

function title(name: string, def: Definition): string {
  return str(def["@mcp.name"]) ?? str(def["@title"]) ?? name;
}

function describe(def: Definition): string | undefined {
  return str(def["@mcp.description"]) ?? str(def["@description"]) ?? def.doc ?? str(def["@title"]);
}

/**
 * An entity's @requires / @restrict as CAP applies them: its own, or, for a composition child
 * (`up_`) with neither, the nearest ancestor's (CAP's `_auth_depends_on`).
 */
function entityAccess(
  def: Definition,
  ctx: Context,
): { requires?: string[]; restrict?: GrantSpec[] } {
  let current: Definition | undefined = def;
  const seen = new Set<Definition>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current["@requires"] !== undefined || current["@restrict"] !== undefined) {
      return { requires: roles(current), restrict: grants(current) };
    }
    const parent: string | undefined = current.elements?.up_?.target;
    current = parent ? ctx.definitions[parent] : undefined;
  }
  return {};
}

/**
 * @restrict as CAP normalizes it (generic/auth/restrictions.js): one grant per event, WRITE as
 * CREATE + UPDATE + DELETE, `grant` defaulting to `*` and `to` to `any`. `where` only filters
 * rows, so it is not kept.
 */
function grants(def: Definition): GrantSpec[] | undefined {
  const restrict = def["@restrict"];
  if (!Array.isArray(restrict)) return undefined;
  return restrict.flatMap((r: { grant?: unknown; to?: unknown }) => {
    const to = list(r.to) ?? ["any"];
    return (list(r.grant) ?? ["*"]).flatMap((grant) =>
      (grant === "WRITE" ? ["CREATE", "UPDATE", "DELETE"] : [grant]).map((g) => ({ grant: g, to })),
    );
  });
}

/** The roles of a service-level @restrict, which CAP's protocol check treats like @requires. */
function restrictRoles(def: Definition): string[] | undefined {
  const restrict = def["@restrict"];
  if (!Array.isArray(restrict)) return undefined;
  const roles = restrict.flatMap((r: { to?: unknown }) => list(r.to) ?? []);
  return roles.length ? roles : undefined;
}

function list(value: unknown): string[] | undefined {
  return typeof value === "string" ? [value] : strings(value);
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
