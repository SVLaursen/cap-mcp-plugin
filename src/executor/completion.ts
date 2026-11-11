import { queryLimits, type Limits } from "../schema-mapper";
import type { EntitySpec, FieldSpec } from "../types";
import { ref, type Args } from "./arguments";
import type { ServiceLike } from "./index";
import { count } from "./reads";

/** `completion/complete` returns at most 100 values (MCP spec). */
export const MAX_COMPLETIONS = 100;

/** Key types stored as text; others are cast, so every database can compare a prefix. */
const TEXT_KEYS = new Set(["cds.String", "cds.LargeString", "cds.UUID"]);

function keyText(key: FieldSpec) {
  return TEXT_KEYS.has(key.cdsType)
    ? ref(key.name)
    : { ...ref(key.name), cast: { type: "cds.String" } };
}

/**
 * Values for the `{key}` of an @mcp.resource template whose key has @mcp.completion: keys
 * that start with `value`, in key order, as the caller may read them (CAP applies @restrict).
 * At most MCP's 100, and never more than the entity's query limits, since CAP pages this query
 * too. One more than kept shows `hasMore`; when CAP's max is below 101 a full page is counted.
 */
export async function completeKey(
  entity: EntitySpec | undefined,
  value: string,
  service: ServiceLike,
  limits: Limits,
): Promise<{ values: string[]; hasMore: boolean }> {
  const key = entity?.keys.length === 1 ? entity.keys[0] : undefined;
  if (!entity?.resource || !key?.completion) return { values: [], hasMore: false };
  const from = { ref: [entity.name] };
  const where = value ? [{ func: "startswith", args: [keyText(key), { val: value }] }] : [];
  const wanted = Math.min(MAX_COMPLETIONS, queryLimits(entity, limits).maxRows);
  // One more than we keep shows there are more, if CAP serves that many.
  const asked = wanted === MAX_COMPLETIONS ? wanted + 1 : wanted;
  const rows = ((await service.run({
    SELECT: {
      from,
      columns: [ref(key.name)],
      ...(where.length && { where }),
      orderBy: [{ ...ref(key.name), sort: "asc" }],
      limit: { rows: { val: asked } },
    },
  })) ?? []) as Args[];
  const values = rows.slice(0, wanted).map((row) => String(row[key.name]));
  if (rows.length > wanted) return { values, hasMore: true };
  if (asked > wanted || rows.length < wanted) return { values, hasMore: false };
  return { values, hasMore: (await count(service, from, where)) > wanted };
}
