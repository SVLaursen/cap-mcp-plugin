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
  V1Options,
} from "../types";
import { isMappedType } from "../schema-mapper";

/**
 * model-reader
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
  /** What a v1 app's config said (v1 shim). */
  v1: V1Options;
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

/** Where a v1 key was found, for its message. */
interface V1Where {
  target: string;
  kind?: string;
  /** Inside a service (not a db entity that projections copy from). */
  inService: boolean;
  /** `@mcp.wrap.tools: false` on the same definition. */
  wrapToolsOff?: boolean;
}

const OPERATION = new Set(["action", "function"]);

/** The message for a v1 opt-in key: mapped, or why it has no effect where it is. */
function v1OptInMessage(
  key: string,
  value: unknown,
  where: V1Where,
  wanted: "entity" | "operation",
) {
  const { target, kind, inService } = where;
  const right = wanted === "operation" ? OPERATION.has(kind ?? "") : kind === "entity";
  if (!right)
    return `${key} is v1 and has no effect on ${target}: v1 read it on ${wanted === "operation" ? "actions and functions" : "entities"} only`;
  if (!inService)
    return `${key} is v1: on ${target} it reaches only the projections that copy it, which v2 does not opt in. Write @mcp on the projections instead`;
  return undefined;
}

/** v1 annotations that v2 maps (to @mcp) or drops, with what to write instead (docs/annotations.md). */
const V1: Record<string, (value: unknown, where: V1Where) => string> = {
  "@mcp.wrap.tools": (value, where) =>
    value !== true
      ? `@mcp.wrap.tools: false is v1: it keeps the v1 list form of @mcp.resource from exposing ${where.target}. Leave out @mcp (and the v1 keys) instead`
      : (v1OptInMessage("@mcp.wrap.tools", value, where, "entity") ??
        `@mcp.wrap.tools is v1: mapped to @mcp on ${where.target}. Write @mcp instead`),
  "@mcp.tool": (value, where) =>
    value !== true
      ? "@mcp.tool is v1 and has no effect: an operation is exposed by @mcp"
      : (v1OptInMessage("@mcp.tool", value, where, "operation") ??
        `@mcp.tool is v1: mapped to @mcp on ${where.target}. Write @mcp instead`),
  "@mcp.usePrimaryKey": () =>
    "@mcp.usePrimaryKey is v1 and has no effect: keys are always the entity keys",
  "@mcp.wrap.name": () =>
    "@mcp.wrap.name is v1 and has no effect: tool names are <Service>_<Entity>_<mode>; use @mcp.name for the title",
};
const V1_HINT = /^@mcp\.wrap\.hint(\.(query|get|create|update|delete))?$/;
/** v1's `wrap_entity_modes` default. */
const V1_WRAP_MODES = ["query", "get", "create", "update"];

/**
 * The v1 annotation that opts a definition in (v1 shim), if any: `@mcp.tool: true`,
 * `@mcp.wrap.tools: true`, or the list form of `@mcp.resource`.
 */
function v1OptIn(def: Definition): `@${string}` | undefined {
  if (OPERATION.has(def.kind ?? "")) return def["@mcp.tool"] === true ? "@mcp.tool" : undefined;
  if (def.kind !== "entity") return undefined;
  if (def["@mcp.wrap.tools"] === true) return "@mcp.wrap.tools";
  // `@mcp.wrap.tools: false` kept v1 from serving the entity as tools.
  if (Array.isArray(def["@mcp.resource"]) && def["@mcp.wrap.tools"] !== false)
    return "@mcp.resource";
  return undefined;
}

/**
 * v1 served an entity as tools (with `@mcp.wrap.modes`, else `wrap_entity_modes`) only with
 * `@mcp.wrap.tools: true`, or with `wrap_entities_to_actions` when wrap.tools was unset.
 */
function v1Wrapped(def: Definition, v1: V1Options): boolean {
  return (
    def["@mcp.wrap.tools"] === true ||
    (v1.wrapEntitiesToActions === true &&
      def["@mcp.resource"] !== undefined &&
      def["@mcp.wrap.tools"] === undefined)
  );
}

export interface ReadOptions {
  /** What a v1 app's config said (v1 shim); only used for V1_DEFAULT_CHANGED. */
  v1?: V1Options;
}

export function readModel(csn: unknown, options: ReadOptions = {}): ModelReadResult {
  const ctx: Context = {
    definitions: (csn as Csn).definitions ?? {},
    diagnostics: [],
    v1: options.v1 ?? {},
  };
  checkAnnotations(ctx);
  const services = Object.entries(ctx.definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name, def]) => readService(name, def, ctx))
    .filter((s): s is ServiceSpec => s !== undefined);
  checkUnused(ctx, services);
  checkV1Defaults(ctx, services);
  return { spec: { services }, diagnostics: ctx.diagnostics };
}

/**
 * v1 shim: what a v1 app got by default (or from v1 config) and no longer gets. Writes from
 * `wrap_entity_modes`, tools from `wrap_entities_to_actions`, and the describe tool.
 */
function checkV1Defaults(ctx: Context, services: ServiceSpec[]): void {
  const v1 = ctx.v1;
  const exposed = new Set(services.flatMap((s) => s.entities.map((e) => e.name)));
  const changed = (target: string, message: string) =>
    ctx.diagnostics.push({ level: "warn", code: "V1_DEFAULT_CHANGED", target, message });
  const names = serviceNames(ctx.definitions);
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind !== "entity" || !serviceOf(name, names)) continue;
    const wrapped = v1Wrapped(def, v1);
    const key = v1OptIn(def);
    if (!wrapped && !key) continue;
    if (!exposed.has(name)) {
      const from = key ?? "wrap_entities_to_actions";
      const copied =
        key && isCopied(def, key, ctx) ? `, copied from ${writtenAt(name, key, ctx)}` : "";
      changed(
        name,
        wrapped
          ? `v1 gave ${name} query and get tools (${from}${copied}); v2 does not. Add @mcp to the entity to keep them`
          : `v1 served ${name} as a resource template (${from}${copied}); v2 does not. Add @mcp to the entity for query and get tools`,
      );
      continue;
    }
    if (!wrapped || def["@mcp.wrap.modes"] !== undefined) continue;
    const lost = (v1.wrapEntityModes ?? V1_WRAP_MODES).filter((m) => m !== "query" && m !== "get");
    if (lost.length === 0) continue;
    changed(
      name,
      `v1 also gave ${name} ${lost.join(", ")} tools (wrap_entity_modes); v2 gives query and get only. Add @mcp.wrap.modes: [${lost.map((m) => `'${m}'`).join(", ")}] to keep them`,
    );
  }
  const v1App =
    Object.keys(v1).length > 0 || ctx.diagnostics.some((d) => d.code === "V1_ANNOTATION");
  // A configured enable_model_description is reported by the config reader.
  if (v1App && v1.describe === undefined) {
    changed(
      "cds.mcp.enable_model_description",
      "v1 served the cap_describe_model tool by default; v2 does not. Add @mcp.describe to a service for a describe tool scoped to it",
    );
  }
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
  const names = serviceNames(ctx.definitions);
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "service") {
      report(name, def);
      continue;
    }
    const service = serviceOf(name, names);
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
  const optedIn = def["@mcp"] === true;
  const entities: EntitySpec[] = [];
  const operations: OperationSpec[] = [];

  for (const [name, member] of Object.entries(ctx.definitions)) {
    if (!name.startsWith(`${service}.`) || isExcluded(member)) continue;
    if (member.kind === "entity") {
      // CAP-generated entities are not baseline, but an explicit @mcp on one still counts.
      const generated = isGenerated(name, member, ctx.definitions);
      const ownOptIn = isOwnOptIn(member, ctx);
      if (generated && !ownOptIn) continue;
      // Outside an @mcp service, only an @mcp written here counts, not one CAP copied in.
      if (optedIn || ownOptIn) entities.push(readEntity(name, service, member, ctx, optedIn));
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

function serviceNames(definitions: Record<string, Definition>): string[] {
  return Object.entries(definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name]) => name);
}

/** The service a definition belongs to: the one whose name is a prefix of its own. */
function serviceOf(name: string, services: string[]): string | undefined {
  return services.find((service) => name.startsWith(`${service}.`));
}

function readEntity(
  name: string,
  service: string,
  def: Definition,
  ctx: Context,
  serviceOptedIn = false,
): EntitySpec {
  // Exposed only by the v1 list form of @mcp.resource: v1 gave no tools, so no writes either.
  const readOnly =
    !serviceOptedIn &&
    def["@mcp"] !== true &&
    v1OptIn(def) === "@mcp.resource" &&
    !v1Wrapped(def, ctx.v1);
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
  checkCompletion(name, def, fields, ctx);
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
    modes: readOnly
      ? readModes(name, withoutModes(def, ctx, name), ctx, isAddressable(def))
      : readModes(name, def, ctx, isAddressable(def), draft && !def["@odata.draft.enabled"]),
    ...entityAccess(def, ctx),
    resource: def["@mcp.resource"] === true,
    // Linked CSN gives draft roots and the compositions inside them a `drafts` entity.
    draft,
    draftRoot: def["@odata.draft.enabled"] === true ? true : undefined,
    deepInsert: elements
      .filter(([, el]) => el.type === "cds.Composition" && el["@mcp.deepInsert"] === true)
      .map(([element, el]) => ({
        element,
        target: el.target ?? "",
        many: el.cardinality?.max === "*",
        backlink: backlinkOf(element, el.on),
      })),
    search: searchColumns(def, ctx),
    limits: rowLimits(name, def, service, ctx),
  };
}

/**
 * CAP's @cds.query.limit, read the way CAP's paging does (libx/_runtime/common/generic/paging.js):
 * `max` from the entity, else the service; the default from the entity's `default` or bare
 * `@cds.query.limit`, else the service's. A max of 0 is "no limit"; a default of 0 is unset.
 */
function rowLimits(
  name: string,
  def: Definition,
  service: string,
  ctx: Context,
): EntitySpec["limits"] {
  const own = (d: Definition | undefined, target: string) => {
    const whole = (key: `@${string}`): number | undefined => {
      const value = d?.[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
      const message = `${key} must be a whole number, not ${JSON.stringify(value)}; ignored`;
      // A service's value is read for each of its entities: report it once.
      if (!ctx.diagnostics.some((x) => x.target === target && x.message === message)) {
        invalid(ctx, target, message);
      }
      return undefined;
    };
    return {
      max: whole("@cds.query.limit.max"),
      default: whole("@cds.query.limit.default") ?? whole("@cds.query.limit"),
    };
  };
  const entity = own(def, name);
  const fromService = own(ctx.definitions[service], service);
  const max = entity.max ?? fromService.max;
  const dflt = entity.default ?? fromService.default;
  const defaultRows = dflt === 0 ? undefined : dflt;
  if (max === undefined && defaultRows === undefined) return undefined;
  return {
    ...(defaultRows !== undefined && { defaultRows }),
    ...(max !== undefined && max > 0 && { maxRows: max }),
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
  draftChild = false,
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
  // A draft's children are written through their root (deep insert), never on their own.
  const writes = [...modes].filter((m) => m === "create" || m === "update" || m === "delete");
  if (draftChild && writes.length) {
    for (const m of writes) modes.delete(m);
    ctx.diagnostics.push({
      level: "error",
      code: "DRAFT_WRITE_NOT_SUPPORTED",
      target: name,
      message: `${name} is part of a draft: ${writes.join(", ")} must go through its root (@mcp.deepInsert); not offered`,
    });
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
  const from = sourceName(def);
  return from ? ctx.definitions[from] : undefined;
}

function sourceName(def: Definition): string | undefined {
  const ref = (def.projection?.from ?? def.query?.SELECT?.from)?.ref?.[0];
  return typeof ref === "string" ? ref : undefined;
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

/**
 * @mcp.completion completes the `{key}` of an @mcp.resource template, so it has an effect only
 * on the single key of such an entity. Elsewhere it is reported, unless CAP copied it here from
 * the entity this one projects (meant for the services where it does apply).
 */
function checkCompletion(name: string, def: Definition, fields: FieldSpec[], ctx: Context): void {
  const keys = fields.filter((f) => f.key);
  const completes = def["@mcp.resource"] === true && keys.length === 1;
  const source = sourceOf(def, ctx)?.elements ?? {};
  for (const field of fields.filter((f) => f.completion)) {
    if (completes && field.key) continue;
    if (source[field.name]?.["@mcp.completion"] === true) continue;
    const why = !field.key
      ? "it completes the key of an @mcp.resource entity, and this is not a key"
      : def["@mcp.resource"] !== true
        ? "it completes resource keys, and this entity has no @mcp.resource"
        : "it completes a single key, and this entity's resource key is composite";
    unusedCompletion(ctx, `${name}:${field.name}`, why);
  }
}

function unusedCompletion(ctx: Context, target: string, why: string): void {
  ctx.diagnostics.push({
    level: "warn",
    code: "UNUSED_ANNOTATION",
    target,
    message: `@mcp.completion on ${target} has no effect: ${why} (MCP completes resource-template variables and prompt arguments, not tool arguments)`,
  });
}

/** The definition without @mcp.wrap.modes, reported as having no effect (v1 shim). */
function withoutModes(def: Definition, ctx: Context, name: string): Definition {
  if (def["@mcp.wrap.modes"] === undefined) return def;
  ctx.diagnostics.push({
    level: "warn",
    code: "V1_ANNOTATION",
    target: name,
    message: `@mcp.wrap.modes on ${name} has no effect: v1 applied it only with @mcp.wrap.tools. Write @mcp and @mcp.wrap.modes instead`,
  });
  const { "@mcp.wrap.modes": _modes, ...rest } = def;
  return rest;
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
  for (const param of params.filter((p) => p.completion)) {
    unusedCompletion(ctx, `${name}:${param.name}`, "this is a tool argument");
  }
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
    elicit: readElicit(name, def["@mcp.elicit"], params, ctx),
    ui: readUi(name, def, ctx),
  };
}

/**
 * `@mcp.elicit`: `['confirm']` and/or parameter names to ask the user for. Any other value is
 * diagnosed, but whatever was written still asks for confirmation: a typo must never switch it
 * off. The flag form (`@mcp.elicit` alone) means `['confirm']`; `[]` asks nothing.
 */
function readElicit(
  name: string,
  value: unknown,
  params: FieldSpec[],
  ctx: Context,
): string[] | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return ["confirm"];
  if (!Array.isArray(value)) {
    invalid(
      ctx,
      name,
      `@mcp.elicit must be a list ('confirm' or parameter names); the call is still confirmed`,
    );
    return ["confirm"];
  }
  const raw = strings(value) ?? [];
  if (raw.length < value.length) {
    invalid(ctx, name, `@mcp.elicit values must be strings; the call is still confirmed`);
    if (!raw.length) return ["confirm"];
  }
  const values = mapV1Input(name, raw, params, ctx);
  for (const v of values) {
    if (v !== "confirm" && !params.some((p) => p.name === v)) {
      invalid(
        ctx,
        name,
        `@mcp.elicit value ${v} is neither 'confirm' nor a parameter of ${name}; the call is still confirmed`,
      );
    }
  }
  if (!values.length) {
    invalid(ctx, name, `@mcp.elicit is an empty list; the call is still confirmed`);
    return ["confirm"];
  }
  return values;
}

/** v1's `@mcp.elicit: ['input']` asked for every parameter: map it to their names (v1 shim). */
function mapV1Input(name: string, values: string[], params: FieldSpec[], ctx: Context): string[] {
  if (!values.includes("input") || params.some((p) => p.name === "input")) return values;
  const names = params.map((p) => p.name);
  ctx.diagnostics.push({
    level: "warn",
    code: "V1_ANNOTATION",
    target: name,
    message: names.length
      ? `@mcp.elicit 'input' is v1: mapped to the parameter names (${names.join(", ")}). List them instead`
      : `@mcp.elicit 'input' is v1: mapped to 'confirm' (${name} has no parameters). Write ['confirm'] instead`,
  });
  // v1's 'input' meant "ask for the parameters"; without parameters there is only 'confirm'.
  const asked = names.length ? names : ["confirm"];
  const mapped = values.flatMap((entry) => (entry === "input" ? asked : [entry]));
  return [...new Set(mapped)];
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
 *
 * CAP copies an entity's (and its elements') annotations to every projection of it. A key
 * copied that way is reported once, where it was written, naming the copies.
 */
function checkAnnotations(ctx: Context): void {
  const reported = new Map<string, Diagnostic>();
  const copies = new Map<string, string[]>();
  const services = serviceNames(ctx.definitions);
  const check = (target: string, def: Definition, writtenAt?: (key: string) => string) => {
    const inService = serviceOf(target, services) !== undefined;
    for (const [key, diagnostic] of checkKeys(target, def, inService)) {
      const origin = writtenAt?.(key) ?? target;
      if (origin === target) {
        ctx.diagnostics.push(diagnostic);
        reported.set(`${target} ${key}`, diagnostic);
      } else copies.set(`${origin} ${key}`, [...(copies.get(`${origin} ${key}`) ?? []), target]);
    }
  };
  for (const [name, def] of Object.entries(ctx.definitions)) {
    if (def.kind === "entity" && isGenerated(name, def, ctx.definitions)) continue;
    check(name, def, (key) => writtenAt(name, key, ctx));
    for (const [element, el] of Object.entries(def.elements ?? {})) {
      check(`${name}:${element}`, el, (key) => writtenAt(name, key, ctx, element));
    }
    // Only entities have bound actions; a linked service also lists its unbound ones here.
    const bound = def.kind === "entity" ? def.actions : undefined;
    for (const [action, op] of Object.entries(bound ?? {})) {
      check(`${name}.${action}`, op);
      for (const [param, p] of Object.entries(op.params ?? {})) {
        check(`${name}.${action}:${param}`, p);
      }
    }
    for (const [param, p] of Object.entries(def.params ?? {})) {
      check(`${name}:${param}`, p);
    }
  }
  for (const [at, targets] of copies) {
    const diagnostic = reported.get(at);
    if (diagnostic) diagnostic.message += ` (CAP copied it to ${targets.sort().join(", ")})`;
  }
}

/**
 * Where an annotation on `name` (or its `element`) was written: the furthest entity down the
 * projection chain that has the same value, so a copy is traced back to its origin.
 */
function writtenAt(name: string, key: string, ctx: Context, element?: string): string {
  const value = (def: Definition | undefined) =>
    JSON.stringify((element ? def?.elements?.[element] : def)?.[key as `@${string}`]);
  let at = name;
  for (let depth = 0; depth < 32; depth++) {
    const from = sourceName(ctx.definitions[at] ?? {});
    if (!from || value(ctx.definitions[from]) !== value(ctx.definitions[at])) break;
    // checkAnnotations does not visit CAP-generated entities: report the copy instead.
    const source = ctx.definitions[from];
    if (source?.kind === "entity" && isGenerated(from, source, ctx.definitions)) break;
    at = from;
  }
  return element ? `${at}:${element}` : at;
}

/** The V1_ANNOTATION message for a v1 key: what the shim mapped it to, or why it is dropped. */
function v1Message(key: string, value: unknown, where: V1Where): string | undefined {
  const { target } = where;
  const known = V1[key];
  if (known) return known(value, where);
  if (V1_HINT.test(key))
    return `${key} is v1 and has no effect: use @mcp.description on the entity`;
  if (key === "@mcp.resource" && Array.isArray(value) && where.wrapToolsOff) {
    return `@mcp.resource with a list of query options is v1 and has no effect on ${target} with @mcp.wrap.tools: false. In v2, @mcp.resource means single records by key`;
  }
  if (key === "@mcp.resource" && Array.isArray(value)) {
    const elsewhere = v1OptInMessage("@mcp.resource", value, where, "entity");
    if (elsewhere)
      return `@mcp.resource with a list of query options is v1${elsewhere.slice("@mcp.resource is v1".length)}`;
    return `@mcp.resource with a list of query options is v1: mapped to @mcp on ${target} (query and get tools). Write @mcp instead; in v2, @mcp.resource means single records by key`;
  }
  return undefined;
}

function checkKeys(target: string, def: Definition, inService: boolean): [string, Diagnostic][] {
  const found: [string, Diagnostic][] = [];
  for (const key of Object.keys(def)) {
    if (key !== "@mcp" && !key.startsWith("@mcp.")) continue;
    const v1 = v1Message(key, def[key as `@${string}`], {
      target,
      kind: def.kind,
      inService,
      wrapToolsOff: def["@mcp.wrap.tools"] === false,
    });
    if (v1) {
      found.push([key, { level: "warn", code: "V1_ANNOTATION", target, message: v1 }]);
    } else if (!KNOWN.has(key)) {
      found.push([
        key,
        {
          level: "warn",
          code: "UNKNOWN_ANNOTATION",
          target,
          message: `Unknown annotation ${key} on ${target}; it has no effect`,
        },
      ]);
    }
  }
  return found;
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

/** `@mcp`, or a v1 annotation the shim maps to it (v1OptIn). */
function isOptedIn(def: Definition): boolean {
  return def["@mcp"] === true || v1OptIn(def) !== undefined;
}

/** Opted in here, not by an annotation CAP copied from the projected entity. */
function isOwnOptIn(def: Definition, ctx: Context): boolean {
  if (def["@mcp"] === true) return !isCopied(def, "@mcp", ctx);
  const v1 = v1OptIn(def);
  return v1 !== undefined && !isCopied(def, v1, ctx);
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
  return text(def["@mcp.hint"]) ?? text(def["@description"]) ?? def.doc;
}

function title(name: string, def: Definition): string {
  return text(def["@mcp.name"]) ?? text(def["@title"]) ?? name;
}

/**
 * A title or description as agents may see it. `{i18n>key}` placeholders are unresolved here
 * (the reader has no locale), so they count as absent and the fallback chain continues.
 */
function text(value: unknown): string | undefined {
  const given = str(value);
  return given && /^\{i18n>[^}]*\}$/.test(given) ? undefined : given;
}

function describe(def: Definition): string | undefined {
  return (
    text(def["@mcp.description"]) ?? text(def["@description"]) ?? def.doc ?? text(def["@title"])
  );
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
