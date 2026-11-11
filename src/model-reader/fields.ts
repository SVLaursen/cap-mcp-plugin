import type { FieldSpec, ReturnSpec } from "../types";
import {
  type Definition,
  type Context,
  ASSOCIATION,
  DRAFT_ELEMENTS,
  isOmitted,
  isExcluded,
  str,
  bound,
  describeElement,
} from "./definitions";

/** Elements and return types as FieldSpecs and ReturnSpecs. */

/** The scalar, non-ignored, non-omitted elements an agent may see. */
export function readFields(elements: Record<string, Definition> = {}): FieldSpec[] {
  return Object.entries(elements)
    .filter(([, el]) => !ASSOCIATION.has(el.type ?? "") && !isExcluded(el) && !isOmitted(el))
    .map(([field, el]) => readField(field, el, elements));
}

/** `returns X`, `returns array of X`, with X a builtin, an entity or an inline structure. */
export function readReturns(returns: Definition | undefined, ctx: Context): ReturnSpec | undefined {
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

/**
 * One element or parameter as the agent sees it. Node.js-flavoured CSN has already resolved
 * named types and `Entity:element` references to builtins, with enums inlined.
 * `siblings` are the other elements of the same entity, to find a foreign key's association.
 */
export function readField(
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
