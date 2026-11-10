import { NotImplementedError } from "../errors";
import type { EntitySpec, FieldSpec, JsonSchema, OperationSpec } from "../types";

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

export function entityInputSchema(_entity: EntitySpec, _mode: string): JsonSchema {
  throw new NotImplementedError("entityInputSchema", "M1");
}

export function entityOutputSchema(_entity: EntitySpec, _mode: string): JsonSchema {
  throw new NotImplementedError("entityOutputSchema", "M1");
}

export function operationInputSchema(_op: OperationSpec): JsonSchema {
  throw new NotImplementedError("operationInputSchema", "M1");
}
