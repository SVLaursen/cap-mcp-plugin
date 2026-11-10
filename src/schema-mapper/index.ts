import { NotImplementedError } from "../errors";
import type { EntityMode, EntitySpec, FieldSpec, JsonSchema, OperationSpec } from "../types";

/**
 * schema-mapper (milestone M1)
 *
 * Maps FieldSpecs to JSON Schema 2020-12 for tool inputs and outputs.
 *
 * Contract:
 * - Pure, no dependencies.
 * - One lookup table from CDS builtin to JSON Schema; no string-suffix tricks like v1's "Optional".
 * - Carries constraints: enum, maxLength (length), minimum/maximum (@assert.range),
 *   precision-safe Decimal/Int64 as strings, format for Date/Time/DateTime/Timestamp/UUID.
 * - Readonly fields never appear in write input schemas. Keys are required on get/update/delete.
 * - Output schemas describe exactly what the executor returns (structuredContent).
 */
/** CDS builtin → JSON Schema. The one place type mapping lives. */
const TYPES: Record<string, JsonSchema> = {
  "cds.String": { type: "string" },
  "cds.LargeString": { type: "string" },
  "cds.UUID": { type: "string", format: "uuid" },
  "cds.Boolean": { type: "boolean" },
  "cds.UInt8": { type: "integer", minimum: 0, maximum: 255 },
  "cds.Int16": { type: "integer", minimum: -32768, maximum: 32767 },
  "cds.Int32": { type: "integer", minimum: -2147483648, maximum: 2147483647 },
  "cds.Integer": { type: "integer", minimum: -2147483648, maximum: 2147483647 },
  // Beyond 2^53 a JSON number loses digits, so these travel as strings (as OData does).
  "cds.Int64": { type: "string", pattern: "^-?\\d+$" },
  "cds.Decimal": { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" },
  "cds.Double": { type: "number" },
  "cds.Date": { type: "string", format: "date" },
  "cds.Time": { type: "string", format: "time" },
  "cds.DateTime": { type: "string", format: "date-time" },
  "cds.Timestamp": { type: "string", format: "date-time" },
  "cds.Binary": { type: "string", contentEncoding: "base64" },
  "cds.LargeBinary": { type: "string", contentEncoding: "base64" },
};

export function fieldToSchema(field: FieldSpec): JsonSchema {
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

const DEFAULT_LIMITS: Limits = { maxRows: 200, defaultRows: 25 };
const OPERATORS = ["eq", "ne", "gt", "ge", "lt", "le", "in", "contains", "startswith", "endswith"];

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
      return object(writable(entity.fields), entity.keys);
    case "create":
      return createSchema(entity, options);
    case "query":
      return querySchema(entity, options.limits ?? DEFAULT_LIMITS);
  }
}

/** Bound operations take the keys of their instance as well as their parameters. */
export function operationInputSchema(op: OperationSpec, boundEntity?: EntitySpec): JsonSchema {
  const keys = boundEntity?.keys ?? [];
  return object([...keys, ...op.params], [...keys, ...op.params.filter((p) => p.mandatory)]);
}

function createSchema(entity: EntitySpec, options: SchemaOptions, parent?: string): JsonSchema {
  // In a deep insert, CAP fills the child's back link to its parent.
  const fields = writable(entity.fields).filter((f) => !parent || f.target !== parent);
  const schema = object(
    fields,
    fields.filter((f) => f.mandatory),
  );
  const properties = schema.properties as Record<string, JsonSchema>;
  for (const { element, target } of entity.deepInsert) {
    const child = options.entities?.(target);
    if (child) {
      properties[element] = { type: "array", items: createSchema(child, options, entity.name) };
    }
  }
  return schema;
}

/**
 * Structured query arguments: never a filter string, so the executor builds CQN objects and
 * only exposed fields can be named. See docs/architecture.md › Tool input shapes.
 */
function querySchema(entity: EntitySpec, limits: Limits): JsonSchema {
  const fields = entity.fields.map((f) => f.name);
  return {
    type: "object",
    properties: {
      q: { type: "string", description: "Free-text search over the entity's searchable fields" },
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

function object(fields: FieldSpec[], required: FieldSpec[]): JsonSchema {
  const schema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldToSchema(f)])),
  };
  if (required.length) schema.required = required.map((f) => f.name);
  schema.additionalProperties = false;
  return schema;
}

export function entityOutputSchema(_entity: EntitySpec, _mode: EntityMode): JsonSchema {
  throw new NotImplementedError("entityOutputSchema", "M1");
}
