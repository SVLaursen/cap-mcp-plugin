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
export function fieldToSchema(_field: FieldSpec): JsonSchema {
  throw new NotImplementedError("fieldToSchema", "M1");
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
