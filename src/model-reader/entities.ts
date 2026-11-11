import type { EntityMode, EntitySpec } from "../types";
import {
  type Definition,
  type Context,
  ASSOCIATION,
  DRAFT_ELEMENTS,
  isOmitted,
  isExcluded,
  isAddressable,
  invalid,
  title,
  describe,
  entityAccess,
  backlinkOf,
} from "./definitions";
import { v1OptIn, v1Wrapped, withoutModes } from "./v1";
import { checkTypes, checkCompletion } from "./checks";
import { readFields } from "./fields";

/** Entities as EntitySpecs: modes, search columns, CAP's row limits, keys and access. */

export const BASELINE: readonly EntityMode[] = ["query", "get"];

/** Modes that act on one record, so they need its keys. */
export const ADDRESSED: ReadonlySet<string> = new Set(["get", "update", "delete"]);

export const MODES: ReadonlySet<string> = new Set<EntityMode>([
  "query",
  "get",
  "create",
  "update",
  "delete",
]);

export function readEntity(
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
export function rowLimits(
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
export function readModes(
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
export function searchColumns(def: Definition, ctx: Context, depth = 0): string[] {
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
