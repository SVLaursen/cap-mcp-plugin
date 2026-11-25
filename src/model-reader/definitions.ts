import type { Diagnostic, GrantSpec, V1Options } from "../types";

/**
 * The CSN shapes the reader works on, and small readers shared by the other files: names,
 * descriptions, access annotations, where a definition comes from.
 */

/** The slice of a CSN definition the reader looks at. Annotations are `@`-prefixed keys. */
export interface Definition {
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

export interface Csn {
  definitions?: Record<string, Definition>;
}

/** What every read step needs: the whole model, and somewhere to report problems. */
export interface Context {
  definitions: Record<string, Definition>;
  diagnostics: Diagnostic[];
  /** What a v1 app's config said (v1 shim). */
  v1: V1Options;
}

export const ASSOCIATION = new Set(["cds.Association", "cds.Composition"]);

/** Elements CAP adds to draft-enabled entities. The executor drives drafts; agents never see them. */
export const DRAFT_ELEMENTS = new Set([
  "IsActiveEntity",
  "HasActiveEntity",
  "HasDraftEntity",
  "DraftAdministrativeData",
  "DraftAdministrativeData_DraftUUID",
  "DraftMessages",
  "SiblingEntity",
]);

export function serviceNames(definitions: Record<string, Definition>): string[] {
  return Object.entries(definitions)
    .filter(([, def]) => def.kind === "service")
    .map(([name]) => name);
}

/** The service a definition belongs to: the one whose name is a prefix of its own. */
export function serviceOf(name: string, services: string[]): string | undefined {
  return services.find((service) => name.startsWith(`${service}.`));
}

/** The entity a projection or view selects from, if any. */
export function sourceOf(def: Definition, ctx: Context): Definition | undefined {
  const from = sourceName(def);
  return from ? ctx.definitions[from] : undefined;
}

export function sourceName(def: Definition): string | undefined {
  const ref = (def.projection?.from ?? def.query?.SELECT?.from)?.ref?.[0];
  return typeof ref === "string" ? ref : undefined;
}

/**
 * True when `key` has the same value on the entity this one projects: CAP copied it here, or it
 * was written again with the same value (the compiled model cannot tell these apart).
 */
export function isCopied(def: Definition, key: `@${string}`, ctx: Context): boolean {
  const source = sourceOf(def, ctx);
  return !!source && JSON.stringify(source[key]) === JSON.stringify(def[key]);
}

/** `on items.up_ = $self` → "up_": the child's association that CAP fills on deep insert. */
export function backlinkOf(element: string, on: unknown): string | undefined {
  if (!Array.isArray(on)) return undefined;
  for (const term of on) {
    const ref = (term as { ref?: unknown[] })?.ref;
    if (Array.isArray(ref) && ref.length === 2 && ref[0] === element) return String(ref[1]);
  }
  return undefined;
}

/** An entity's records can be addressed when it has keys and none of them is @mcp.omit. */
export function isAddressable(def: Definition): boolean {
  const keys = Object.values(def.elements ?? {}).filter((el) => el.key);
  return keys.length > 0 && !keys.some(isOmitted);
}

/** An @assert.range bound; `_` (open) compiles to `{ "=": "_" }`. */
export function bound(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Where an annotation on `name` (or its `element`) was written: the furthest entity down the
 * projection chain that has the same value, so a copy is traced back to its origin.
 */
export function writtenAt(name: string, key: string, ctx: Context, element?: string): string {
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

export function invalid(ctx: Context, target: string, message: string): void {
  ctx.diagnostics.push({ level: "error", code: "INVALID_ANNOTATION_VALUE", target, message });
}

/** CAP propagates @mcp.omit to generated foreign keys and through projections. */
export function isOmitted(element: Definition): boolean {
  return element["@mcp.omit"] === true;
}

export function isExcluded(def: Definition): boolean {
  return def["@mcp"] === false || def["@cds.api.ignore"] === true;
}

/** Entities CAP adds on its own (localized texts, draft bookkeeping) are never baseline. */
export function isGenerated(
  name: string,
  def: Definition,
  definitions: Record<string, Definition>,
): boolean {
  if (def["@cds.autoexposed"] === true || name.endsWith(".DraftAdministrativeData")) return true;
  const parent = name.endsWith(".texts") ? definitions[name.slice(0, -".texts".length)] : undefined;
  return parent?.elements?.texts?.target === name;
}

export function describeElement(def: Definition): string | undefined {
  return text(def["@mcp.hint"]) ?? text(def["@description"]) ?? def.doc;
}

export function title(name: string, def: Definition): string {
  return text(def["@mcp.name"]) ?? text(def["@title"]) ?? name;
}

/**
 * A title or description as agents may see it. `{i18n>key}` placeholders are unresolved here
 * (the reader has no locale), so they count as absent and the fallback chain continues.
 */
export function text(value: unknown): string | undefined {
  const given = str(value);
  return given && /^\{i18n>[^}]*\}$/.test(given) ? undefined : given;
}

export function describe(def: Definition): string | undefined {
  return (
    text(def["@mcp.description"]) ?? text(def["@description"]) ?? def.doc ?? text(def["@title"])
  );
}

/**
 * An entity's @requires / @restrict as CAP applies them: its own, or, for a composition child
 * (`up_`) with neither, the nearest ancestor's (CAP's `_auth_depends_on`).
 */
export function entityAccess(
  def: Definition,
  ctx: Context,
): { requires?: string[]; restrict?: GrantSpec[] } {
  let current: Definition | undefined = def;
  const seen = new Set<Definition>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current["@requires"] !== undefined || current["@restrict"] !== undefined) {
      // CAP adds an ancestor's `where` only to the ancestor's path, never to a direct read of
      // the child, so inherited grants filter nothing (ADR 0015).
      const restrict = grants(current);
      return {
        requires: roles(current),
        restrict: current === def ? restrict : restrict?.map(({ grant, to }) => ({ grant, to })),
      };
    }
    const parent: string | undefined = current.elements?.up_?.target;
    current = parent ? ctx.definitions[parent] : undefined;
  }
  return {};
}

/**
 * @restrict as CAP normalizes it (generic/auth/restrictions.js): one grant per event, WRITE as
 * CREATE + UPDATE + DELETE, `grant` defaulting to `*` and `to` to `any`. A `where` only filters
 * rows: whether there is one is kept (ADR 0015), the condition is not.
 */
export function grants(def: Definition): GrantSpec[] | undefined {
  const restrict = def["@restrict"];
  if (!Array.isArray(restrict)) return undefined;
  return restrict.flatMap((r: { grant?: unknown; to?: unknown; where?: unknown }) => {
    const to = list(r.to) ?? ["any"];
    // CAP checks the value, not the key: an empty `where` adds no condition.
    const where = r.where ? { where: true as const } : {};
    return (list(r.grant) ?? ["*"]).flatMap((grant) =>
      (grant === "WRITE" ? ["CREATE", "UPDATE", "DELETE"] : [grant]).map((g) => ({
        grant: g,
        to,
        ...where,
      })),
    );
  });
}

/** The roles of a service-level @restrict, which CAP's protocol check treats like @requires. */
export function restrictRoles(def: Definition): string[] | undefined {
  const restrict = def["@restrict"];
  if (!Array.isArray(restrict)) return undefined;
  const roles = restrict.flatMap((r: { to?: unknown }) => list(r.to) ?? []);
  return roles.length ? roles : undefined;
}

export function list(value: unknown): string[] | undefined {
  return typeof value === "string" ? [value] : strings(value);
}

/** @requires: 'role' or ['a', 'b']. Only for hiding tools; CAP enforces it on every request. */
export function roles(def: Definition): string[] | undefined {
  const requires = def["@requires"];
  return typeof requires === "string" ? [requires] : strings(requires);
}

export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
