import { queryLimits, type Limits } from "../schema-mapper";
import type { EntitySpec } from "../types";
import {
  addressed,
  allowOnly,
  and,
  byName,
  conditions,
  decodeCursor,
  encodeCursor,
  field,
  integer,
  keyOf,
  list,
  project,
  ref,
  search,
  sortBy,
  type Args,
} from "./arguments";
import { ToolError, notFound } from "./errors";
import type { ServiceLike } from "./index";
import { resourceLinks } from "./resources";
import { result, type ToolResult } from "./results";

/**
 * The query tool: `{ rows, total, nextCursor }`. Only exposed fields can be selected, filtered,
 * searched or sorted on; the page size is the one the tool advertises (CAP's @cds.query.limit,
 * capped by cds.mcp.limits), so CAP never cuts a page short.
 */
export async function query(
  entity: EntitySpec,
  args: Args,
  service: ServiceLike,
  limits: Limits,
  filtered = false,
): Promise<ToolResult> {
  allowOnly(args, ["q", "where", "orderby", "select", "top", "cursor"]);
  const fields = byName(entity.fields);
  const wanted = list(args.select, "select");
  if (wanted && (wanted.length === 0 || new Set(wanted).size !== wanted.length)) {
    throw new ToolError("INVALID_ARGUMENT", "select needs distinct field names", "select");
  }
  const columns = (wanted ?? [...fields.keys()]).map((name) =>
    ref(field(fields, String(name), "select").name),
  );
  // Keys are always read (resource links need them) and dropped again by project().
  const read = [
    ...columns,
    ...entity.keys
      .filter((key) => !columns.some((column) => column.ref[0] === key.name))
      .map((key) => ref(key.name)),
  ];
  const where = and(conditions(fields, args.where), search(entity, args.q));
  const orderBy = [
    ...(list(args.orderby, "orderby") ?? []).map((entry) => sortBy(fields, entry)),
    // Keys last, so pages are stable and neither overlap nor skip.
    ...entity.keys.map((key) => ({ ref: [key.name], sort: "asc" })),
  ];
  const page = queryLimits(entity, limits);
  const top = integer(args.top ?? page.defaultRows, "top", 1, page.maxRows);
  const offset = decodeCursor(args.cursor);
  const from = { ref: [entity.name] };
  const rows = (await service.run({
    SELECT: {
      from,
      columns: read,
      ...(where.length && { where }),
      orderBy,
      limit: { rows: { val: top }, offset: { val: offset } },
    },
  })) as Args[];
  const total = await count(service, from, where);
  const next = offset + rows.length;
  // Exactly what was selected: CAP adds keys and draft columns (IsActiveEntity) to draft reads.
  const selected = columns.map((column) => column.ref[0] as string);
  return result(
    {
      // First, so an agent reads it before the rows (ADR 0015).
      ...(filtered && { notice: filterNotice(entity) }),
      rows: rows.map((row) => project(row, selected)),
      total,
      ...(next < total && rows.length > 0 && { nextCursor: encodeCursor(next) }),
    },
    resourceLinks(entity, rows),
  );
}

/** How many records match, without limit, offset or order: counting the page gives its size. */
export async function count(service: ServiceLike, from: unknown, where: unknown[]) {
  const counted = (await service.run({
    SELECT: {
      one: true,
      from,
      columns: [{ func: "count", args: ["*"], as: "total" }],
      ...(where.length && { where }),
    },
  })) as { total: number | string } | undefined;
  return Number(counted?.total ?? 0);
}

/**
 * ADR 0015: what a filtered query result says. Nothing about the condition, its attribute, a
 * value, or how many records were left out: only that a filter applies.
 */
export const filterNotice = (entity: EntitySpec) =>
  `Your authorization limits which ${entity.title} records you can see. Records outside it are ` +
  "not included in this result. An empty or smaller result does not mean that no other records exist.";

/**
 * The get tool: one record by its key, NOT_FOUND when the caller cannot read it. When CAP
 * filters the caller's reads, not found may also mean not visible, and the error says so.
 */
export async function get(
  entity: EntitySpec,
  args: Args,
  service: ServiceLike,
  filtered = false,
): Promise<ToolResult> {
  const key = keyOf(entity, args);
  const names = entity.fields.map((f) => f.name);
  const row = (await service.run({
    SELECT: { one: true, from: addressed(entity, key), columns: names.map(ref) },
  })) as Args | undefined;
  if (!row) throw notFound(entity, key, filtered);
  return result(project(row, names), resourceLinks(entity, [row]));
}
