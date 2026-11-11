import { isOperator } from "../schema-mapper";
import type { EntitySpec, FieldSpec } from "../types";
import { isObject, typeName } from "../util";
import { ToolError } from "./errors";

/**
 * Checking what an agent sent, and turning it into CQN pieces. The SDK checks arguments against
 * the input schema too, but compact tools have open schemas, and the executor must never trust a
 * field name it did not expose: every check here throws INVALID_ARGUMENT with the argument's path.
 */

export type Args = Record<string, unknown>;

/** Refuse arguments other than `allowed` (undefined ones are fine). */
export function allowOnly(args: Args, allowed: string[]): void {
  const extra = Object.keys(args).find((k) => !allowed.includes(k) && args[k] !== undefined);
  if (extra) throw new ToolError("INVALID_ARGUMENT", `Unexpected argument ${extra}`, extra);
}

export function list(given: unknown, at: string): unknown[] | undefined {
  if (given === undefined) return undefined;
  if (!Array.isArray(given)) throw new ToolError("INVALID_ARGUMENT", `${at} must be an array`, at);
  return given;
}

export function object(given: unknown, at: string): Args {
  if (!isObject(given)) throw new ToolError("INVALID_ARGUMENT", `${at} must be an object`, at);
  return given;
}

export function integer(given: unknown, at: string, min: number, max: number): number {
  if (typeof given !== "number" || !Number.isInteger(given) || given < min || given > max) {
    throw new ToolError("INVALID_ARGUMENT", `${at} must be an integer from ${min} to ${max}`, at);
  }
  return given;
}

/** An exposed field by name. */
export function field(fields: Map<string, FieldSpec>, name: string, at: string): FieldSpec {
  const spec = fields.get(name);
  if (!spec) throw new ToolError("INVALID_ARGUMENT", `Unknown field ${name}`, at);
  return spec;
}

/** Types whose values are JSON numbers. */
const NUMBER_TYPES = new Set([
  "cds.Integer",
  "cds.Int16",
  "cds.Int32",
  "cds.UInt8",
  "cds.Double",
  "cds.hana.REAL",
  "cds.hana.TINYINT",
  "cds.hana.SMALLINT",
]);
/** Types that may exceed a JSON number's precision: a number, or digits as a string. */
const DIGIT_TYPES = new Set([
  "cds.Int64",
  "cds.Integer64",
  "cds.Decimal",
  "cds.DecimalFloat",
  "cds.hana.SMALLDECIMAL",
]);
const DIGITS = /^-?\d+(\.\d+)?$/;

function fitsType(cdsType: string, given: unknown): boolean {
  if (cdsType === "cds.Boolean") return typeof given === "boolean";
  if (NUMBER_TYPES.has(cdsType)) return typeof given === "number";
  if (DIGIT_TYPES.has(cdsType)) {
    return typeof given === "number" || (typeof given === "string" && DIGITS.test(given));
  }
  return typeof given === "string";
}

/** `given`, checked against the field's type. */
export function value(spec: FieldSpec, given: unknown, at: string): unknown {
  if (!fitsType(spec.cdsType, given)) {
    const type = typeName(spec.cdsType);
    throw new ToolError(
      "INVALID_ARGUMENT",
      `${JSON.stringify(given)} is not a valid ${type} for ${spec.name}`,
      at,
    );
  }
  return given;
}

/** Exactly the entity's keys, each of its type. */
export function keyOf(entity: EntitySpec, args: Args): Args {
  allowOnly(
    args,
    entity.keys.map((k) => k.name),
  );
  return Object.fromEntries(
    entity.keys.map((key) => {
      if (args[key.name] === undefined) {
        throw new ToolError("INVALID_ARGUMENT", `Missing key ${key.name}`, key.name);
      }
      return [key.name, value(key, args[key.name], key.name)];
    }),
  );
}

export const ref = (name: string) => ({ ref: [name] });

export const byName = (fields: FieldSpec[]) => new Map(fields.map((f) => [f.name, f]));

/** The named properties of `row` that it has. */
export const project = (row: Args, names: string[]) =>
  Object.fromEntries(names.filter((n) => n in row).map((n) => [n, row[n]]));

/** Join condition token lists with `and`, wrapping each so `or` inside one stays contained. */
export function and(...parts: unknown[][]): unknown[] {
  const present = parts.filter((part) => part.length > 0);
  if (present.length <= 1) return present[0] ?? [];
  return present.flatMap((part, i) => [...(i ? ["and"] : []), { xpr: part }]);
}

/**
 * One record, addressed like OData's `Books(201)`: the key as a filter on the entity reference.
 * CAP then puts the key into req.data, which custom handlers rely on (req.data.ID).
 */
export const keyWhere = (key: Args) =>
  and(...Object.entries(key).map(([name, val]) => [ref(name), "=", { val }]));

export const addressed = (entity: EntitySpec, key: Args) => ({
  ref: [{ id: entity.name, where: keyWhere(key) }],
});

const COMPARISONS = {
  eq: "=",
  ne: "!=",
  gt: ">",
  ge: ">=",
  lt: "<",
  le: "<=",
} as const;

type TextFunction = "contains" | "startswith" | "endswith";
const TEXT_FUNCTIONS: ReadonlySet<string> = new Set<TextFunction>([
  "contains",
  "startswith",
  "endswith",
]);
const isTextFunction = (op: string): op is TextFunction => TEXT_FUNCTIONS.has(op);
const STRING_TYPES = new Set(["cds.String", "cds.LargeString"]);

/** The query tools' `where`: conditions over exposed fields, all of which must hold. */
export function conditions(fields: Map<string, FieldSpec>, where: unknown): unknown[] {
  return and(
    ...(list(where, "where") ?? []).map((condition, i) => {
      const entry = object(condition, `where[${i}]`);
      allowOnly(entry, ["field", "op", "value"]);
      const target = field(fields, String(entry.field), `where[${i}].field`);
      const op = String(entry.op);
      if (!isOperator(op)) {
        throw new ToolError("INVALID_ARGUMENT", `Unknown operator ${op}`, `where[${i}].op`);
      }
      const at = `where[${i}].value`;
      if (op === "in") {
        if (!Array.isArray(entry.value))
          throw new ToolError("INVALID_ARGUMENT", "'in' needs an array", at);
        const items = entry.value.map((item) => ({ val: value(target, item, at) }));
        return [ref(target.name), "in", { list: items }];
      }
      if (isTextFunction(op)) {
        if (!STRING_TYPES.has(target.cdsType)) {
          throw new ToolError(
            "INVALID_ARGUMENT",
            `'${op}' needs a string field; ${target.name} is not one`,
            at,
          );
        }
        return [{ func: op, args: [ref(target.name), { val: value(target, entry.value, at) }] }];
      }
      // `= null` matches nothing in SQL: eq/ne null become `is null` / `is not null`.
      if (entry.value === null && (op === "eq" || op === "ne")) {
        return [ref(target.name), op === "eq" ? "is" : "is not", { val: null }];
      }
      return [ref(target.name), COMPARISONS[op], { val: value(target, entry.value, at) }];
    }),
  );
}

/** CAP's search function over exactly the spec's columns, never CAP's default (all Strings). */
export function search(entity: EntitySpec, q: unknown): unknown[] {
  if (q === undefined || q === "") return [];
  if (typeof q !== "string") throw new ToolError("INVALID_ARGUMENT", "q must be a string", "q");
  if (entity.search.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", `${entity.title} has nothing to search`, "q");
  }
  const refs = entity.search.map((path) => ({ ref: path.split(".") }));
  return [{ func: "search", args: [refs.length === 1 ? refs[0] : { list: refs }, { val: q }] }];
}

/** One `orderby` entry: an exposed field, ascending unless `dir: "desc"`. */
export function sortBy(fields: Map<string, FieldSpec>, entry: unknown) {
  const order = object(entry, "orderby");
  allowOnly(order, ["field", "dir"]);
  const dir = order.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc")
    throw new ToolError("INVALID_ARGUMENT", "dir is asc or desc", "orderby");
  return { ref: [field(fields, String(order.field), "orderby").name], sort: dir };
}

/** Stateless paging: the cursor is just the next offset, opaque to the agent. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

export function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(String(cursor), "base64url").toString()) as {
      offset: unknown;
    };
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // Not base64url JSON: the same answer as any other cursor this server never returned.
  }
  throw new ToolError("INVALID_ARGUMENT", "cursor is not one this server returned", "cursor");
}
