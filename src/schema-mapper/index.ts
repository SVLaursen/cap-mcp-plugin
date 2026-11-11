import type {
  EntityMode,
  EntitySpec,
  FieldSpec,
  JsonSchema,
  OperationSpec,
  PromptSpec,
} from "../types";
import { typeName } from "../util";

/**
 * schema-mapper
 *
 * Maps FieldSpecs to JSON Schema 2020-12 for tool inputs and outputs.
 *
 * Contract:
 * - Pure, no dependencies.
 * - One lookup table from CDS builtin to JSON Schema; no type names matched by suffix.
 * - Carries constraints: enum, maxLength (length), minimum/maximum (@assert.range),
 *   precision-safe Decimal/Int64 as strings, format for Date/Time/DateTime/Timestamp/UUID.
 * - Readonly fields never appear in write input schemas. Keys are required on get/update/delete.
 * - Output schemas describe exactly what the executor returns (structuredContent).
 */
const INT16: JsonSchema = { type: "integer", minimum: -32768, maximum: 32767 };
const INT32: JsonSchema = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
const UINT8: JsonSchema = { type: "integer", minimum: 0, maximum: 255 };
// Beyond 2^53 a JSON number loses digits, so these travel as strings (CAP returns them so).
const INT64: JsonSchema = { type: "string", pattern: "^-?\\d+$" };
const DECIMAL: JsonSchema = { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" };
const STRING: JsonSchema = { type: "string" };
const BINARY: JsonSchema = { type: "string", contentEncoding: "base64" };

/** CDS builtin → JSON Schema. The one place type mapping lives. */
const TYPES: Record<string, JsonSchema> = {
  "cds.String": STRING,
  "cds.LargeString": STRING,
  "cds.UUID": { type: "string", format: "uuid" },
  "cds.Boolean": { type: "boolean" },
  "cds.UInt8": UINT8,
  "cds.Int16": INT16,
  "cds.Int32": INT32,
  "cds.Integer": INT32,
  "cds.Int64": INT64,
  "cds.Integer64": INT64,
  "cds.Decimal": DECIMAL,
  "cds.DecimalFloat": DECIMAL,
  "cds.Double": { type: "number" },
  "cds.Date": { type: "string", format: "date" },
  // Not `format: time`: RFC 3339 full-time needs a zone, and CAP returns "10:00:00".
  "cds.Time": { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$" },
  "cds.DateTime": { type: "string", format: "date-time" },
  "cds.Timestamp": { type: "string", format: "date-time" },
  "cds.Binary": BINARY,
  "cds.LargeBinary": BINARY,
  "cds.Map": { type: "object" },
  "cds.hana.TINYINT": UINT8,
  "cds.hana.SMALLINT": INT16,
  "cds.hana.SMALLDECIMAL": DECIMAL,
  "cds.hana.REAL": { type: "number" },
  "cds.hana.CHAR": STRING,
  "cds.hana.NCHAR": STRING,
  "cds.hana.VARCHAR": STRING,
  "cds.hana.CLOB": STRING,
  "cds.hana.BINARY": BINARY,
};

/** Numeric types that travel as strings; inputs also take JSON numbers, as CAP does. */
const NUMERIC_STRINGS = new Set([INT64, DECIMAL]);

/** Whether a CDS builtin has a JSON Schema mapping. Unmapped types are diagnosed by the reader. */
export function isMappedType(cdsType: string): boolean {
  return cdsType in TYPES;
}

export function fieldToSchema(field: FieldSpec): JsonSchema {
  if (field.many) {
    const { many: _many, description, ...item } = field;
    const schema: JsonSchema = { type: "array", items: fieldToSchema(item) };
    if (description) schema.description = description;
    return schema;
  }
  const schema: JsonSchema = { ...(TYPES[field.cdsType] ?? {}) };
  if (field.length !== undefined && schema.type === "string") schema.maxLength = field.length;
  if (field.enum) {
    // The declared values are the whole domain; type bounds would only add noise.
    delete schema.minimum;
    delete schema.maximum;
    schema.enum = [...field.enum];
  }
  const [min, max] = field.range ?? [];
  if (min !== undefined) schema.minimum = min;
  if (max !== undefined) schema.maximum = max;
  if (field.description) schema.description = field.description;
  return schema;
}

/** What an elicitation form may say about one primitive field (MCP's restricted schema). */
const FORM_KEYWORDS = new Set([
  "type",
  "description",
  "minLength",
  "maxLength",
  "format",
  "minimum",
  "maximum",
  "enum",
]);
const FORM_TYPES = new Set(["string", "integer", "number", "boolean"]);
const FORM_FORMATS = new Set(["email", "uri", "date", "date-time"]);

/**
 * The form that asks the user to confirm an @mcp.elicit operation. `confirm` asks for nothing
 * but a yes; listed parameter names are asked for too, pre-filled with the agent's values, so
 * the user sees and may change them. Parameters a form cannot hold (arrays, structures, types
 * without one JSON type) are not asked for; the agent's value stands.
 */
export function elicitationSchema(op: OperationSpec, args: Record<string, unknown>): JsonSchema {
  const asked = op.params.filter((p) => op.elicit?.includes(p.name) && !p.many);
  const properties: Record<string, JsonSchema> = {};
  for (const p of asked) {
    const full = fieldToSchema(p);
    if (typeof full.type !== "string" || !FORM_TYPES.has(full.type)) continue;
    const form = Object.fromEntries(Object.entries(full).filter(([k]) => FORM_KEYWORDS.has(k)));
    if (typeof form.format === "string" && !FORM_FORMATS.has(form.format)) delete form.format;
    const given = args[p.name];
    if (given !== undefined && given !== null) form.default = given;
    properties[p.name] = form;
  }
  const required = asked.filter((p) => p.mandatory && properties[p.name]).map((p) => p.name);
  return { type: "object", properties, ...(required.length && { required }) };
}

/** Row limits for the query tool, from cds.env.mcp.limits (docs/annotations.md). */
export interface Limits {
  maxRows: number;
  defaultRows: number;
}

export interface SchemaOptions {
  limits?: Limits;
  /** Finds a composition target's EntitySpec, for deep insert. */
  entities?: (name: string) => EntitySpec | undefined;
}

export const DEFAULT_LIMITS: Limits = { maxRows: 200, defaultRows: 25 };

/**
 * The limits of one entity's query tool: CAP's own (EntitySpec.limits, from @cds.query.limit),
 * which CAP applies to MCP's queries anyway, capped by ours. The default never exceeds the max.
 * The schema advertises these and the executor enforces the same.
 */
export function queryLimits(entity: EntitySpec, limits: Limits = DEFAULT_LIMITS): Limits {
  const maxRows = Math.min(limits.maxRows, entity.limits?.maxRows ?? Infinity);
  const defaultRows = Math.min(maxRows, entity.limits?.defaultRows ?? limits.defaultRows);
  return { maxRows, defaultRows };
}

/** Comparison operators of the query tools' `where`. */
export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "in",
  "contains",
  "startswith",
  "endswith",
] as const;
export type Operator = (typeof OPERATORS)[number];

export function isOperator(op: string): op is Operator {
  return (OPERATORS as readonly string[]).includes(op);
}

export function entityInputSchema(
  entity: EntitySpec,
  mode: EntityMode,
  options: SchemaOptions = {},
): JsonSchema {
  switch (mode) {
    case "get":
    case "delete":
      return object(entity.keys, entity.keys);
    case "update":
      // Keys are the record's address, so they stay even when read-only.
      return withChildren(
        object([...entity.keys, ...ownFields(entity).filter((f) => !f.key)], entity.keys),
        entity,
        options,
        [entity.name],
      );
    case "create":
      return createSchema(entity, options, [entity.name]);
    case "query":
      return querySchema(entity, queryLimits(entity, options.limits));
  }
}

/** Bound operations take the keys of their instance as well as their parameters. */
export function operationInputSchema(op: OperationSpec, boundEntity?: EntitySpec): JsonSchema {
  const keys = boundEntity?.keys ?? [];
  return object([...keys, ...op.params], [...keys, ...op.params.filter((p) => p.mandatory)]);
}

/**
 * `path` is the chain of entities above this one. An entity may appear twice in it (a
 * self-composition nests once), never more, so recursive compositions stay finite.
 */
function createSchema(
  entity: EntitySpec,
  options: SchemaOptions,
  path: string[],
  backlink?: string,
): JsonSchema {
  // In a deep insert, CAP fills the child's back link to its parent.
  const fields = ownFields(entity).filter((f) => !backlink || f.association !== backlink);
  return withChildren(
    object(
      fields,
      fields.filter((f) => f.mandatory),
    ),
    entity,
    options,
    path,
  );
}

/** Writable fields, minus foreign keys of to-one compositions offered as nested objects. */
function ownFields(entity: EntitySpec): FieldSpec[] {
  const nested = new Set(entity.deepInsert.map((d) => d.element));
  return writable(entity.fields).filter((f) => !f.association || !nested.has(f.association));
}

function withChildren(
  schema: JsonSchema,
  entity: EntitySpec,
  options: SchemaOptions,
  path: string[],
): JsonSchema {
  const properties = schema.properties as Record<string, JsonSchema>;
  for (const { element, target, many, backlink } of entity.deepInsert) {
    const child = options.entities?.(target);
    if (!child || path.filter((name) => name === target).length >= 2) continue;
    const item = createSchema(child, options, [...path, target], backlink);
    properties[element] = many ? { type: "array", items: item } : item;
  }
  return schema;
}

/**
 * Structured query arguments: never a filter string, so the executor builds CQN objects and
 * only exposed fields can be named. See docs/architecture.md › Tool input shapes.
 */
function querySchema(entity: EntitySpec, limits: Limits): JsonSchema {
  const fields = entity.fields.map((f) => f.name);
  const search: Record<string, JsonSchema> = entity.search.length
    ? { q: { type: "string", description: `Free-text search over ${entity.search.join(", ")}` } }
    : {};
  return {
    type: "object",
    properties: {
      ...search,
      where: {
        type: "array",
        description: "Conditions, all of which must hold",
        items: {
          type: "object",
          properties: {
            field: { enum: fields },
            op: { enum: OPERATORS },
            value: { description: "Compared with the field; an array for 'in'" },
          },
          required: ["field", "op", "value"],
          additionalProperties: false,
        },
      },
      orderby: {
        type: "array",
        items: {
          type: "object",
          properties: { field: { enum: fields }, dir: { enum: ["asc", "desc"] } },
          required: ["field"],
          additionalProperties: false,
        },
      },
      select: { type: "array", items: { enum: fields }, uniqueItems: true },
      top: { type: "integer", minimum: 1, maximum: limits.maxRows, default: limits.defaultRows },
      cursor: { type: "string", description: "nextCursor from the previous page" },
    },
    additionalProperties: false,
  };
}

function writable(fields: FieldSpec[]): FieldSpec[] {
  return fields.filter((f) => !f.readonly);
}

function inputField(field: FieldSpec): JsonSchema {
  const schema = fieldToSchema(field);
  const base = TYPES[field.cdsType];
  if (base && NUMERIC_STRINGS.has(base) && !schema.enum) schema.type = ["string", "number"];
  return schema;
}

function object(fields: FieldSpec[], required: FieldSpec[]): JsonSchema {
  const schema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, inputField(f)])),
  };
  if (required.length) schema.required = required.map((f) => f.name);
  schema.additionalProperties = false;
  return schema;
}

/** What the executor returns as structuredContent for an entity tool. */
export function entityOutputSchema(entity: EntitySpec, mode: EntityMode): JsonSchema {
  const row = record(entity.fields);
  switch (mode) {
    case "query":
      return {
        type: "object",
        properties: {
          rows: { type: "array", items: row },
          total: { type: "integer", minimum: 0 },
          nextCursor: { type: "string" },
        },
        required: ["rows", "total"],
      };
    case "get":
    case "create":
    case "update":
      return row;
    case "delete":
      // { deleted: <the key> }, so the agent sees which record went.
      return {
        type: "object",
        properties: {
          deleted: {
            type: "object",
            properties: Object.fromEntries(entity.keys.map((k) => [k.name, fieldToSchema(k)])),
            required: entity.keys.map((k) => k.name),
          },
        },
        required: ["deleted"],
      };
  }
}

/** Prompt arguments are strings: the pattern a value of each CDS type must match. */
const PROMPT_PATTERNS: Record<string, string> = {
  Integer: "^-?\\d+$",
  Int16: "^-?\\d+$",
  Int32: "^-?\\d+$",
  Int64: "^-?\\d+$",
  UInt8: "^\\d+$",
  Decimal: "^-?\\d+(\\.\\d+)?$",
  Double: "^-?\\d+(\\.\\d+)?$",
};

/**
 * The arguments of an @mcp.prompts entry. Prompt arguments are strings on the wire, so every
 * input is a string that must look like its type (an Integer like an integer). All inputs are
 * required: the template uses each.
 */
export function promptArgsSchema(prompt: PromptSpec): JsonSchema {
  const property = (type: string): JsonSchema => {
    const local = typeName(type);
    if (local === "Boolean") return { enum: ["true", "false"] };
    const pattern = PROMPT_PATTERNS[local];
    return pattern ? { type: "string", pattern } : { type: "string" };
  };
  return {
    type: "object",
    properties: Object.fromEntries(prompt.inputs.map((i) => [i.key, property(i.type)])),
    required: prompt.inputs.map((i) => i.key),
    additionalProperties: false,
  };
}

/**
 * Always `{ value }`. 2026-07-28 allows any JSON as structuredContent, but one shape for every
 * operation is simpler for agents, 2025-era clients need an object, and a single record may be
 * null (nothing found) without failing the SDK's output validation.
 */
export function operationOutputSchema(op: OperationSpec): JsonSchema | undefined {
  const returns = op.returns;
  if (!returns) return undefined;
  const one = returns.scalar ? outputField(returns.scalar) : record(returns.fields ?? []);
  const value: JsonSchema = returns.many
    ? { type: "array", items: one }
    : returns.scalar
      ? one
      : { ...one, type: ["object", "null"] };
  return { type: "object", properties: { value } };
}

/**
 * A record as CAP returns it. No `required`: `select` may leave fields out. No
 * `additionalProperties: false`: the executor strips anything not exposed.
 */
function record(fields: FieldSpec[]): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, outputField(f)])),
  };
}

/** Outputs may be null unless the field is a key or `not null` (@mandatory guards input only). */
function outputField(field: FieldSpec): JsonSchema {
  const schema = fieldToSchema(field);
  if (field.key || field.notNull) return schema;
  if (typeof schema.type === "string") schema.type = [schema.type, "null"];
  if (Array.isArray(schema.enum)) schema.enum = [...schema.enum, null];
  return schema;
}
