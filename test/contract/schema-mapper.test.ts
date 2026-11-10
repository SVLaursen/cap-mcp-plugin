/**
 * M1 — schema-mapper: FieldSpec / EntitySpec / OperationSpec → JSON Schema 2020-12.
 */
describe("schema-mapper: scalar types", () => {
  test.todo("String → string with maxLength from length");
  test.todo("Integer, Int16, Int32, UInt8 → integer with the type's bounds");
  test.todo("Int64 and Decimal → string with a numeric pattern (precision-safe)");
  test.todo("Double → number");
  test.todo("Boolean → boolean");
  test.todo("UUID → string, format uuid");
  test.todo("Date → string, format date; Time → time; DateTime/Timestamp → date-time");
  test.todo("enum → enum of the declared values");
  test.todo("@assert.range → minimum/maximum");
  test.todo("description is copied when present");
});

describe("schema-mapper: tool input schemas", () => {
  test.todo("get: required keys only, additionalProperties false");
  test.todo("query: where/orderby/select only offer non-omitted scalar fields; top max 200");
  test.todo("create: readonly fields absent; mandatory fields required");
  test.todo("update: keys required; every other writable field optional");
  test.todo("delete: required keys only");
  test.todo("operation: params mapped; mandatory params required; optional otherwise");
  test.todo("deep insert: opted-in compositions appear as arrays of the target's create schema");
});

describe("schema-mapper: tool output schemas", () => {
  test.todo("query output is { rows: Entity[], total: integer, nextCursor?: string }");
  test.todo("get output is the entity object without omitted fields");
  test.todo("operation output follows the CDS return type (scalar wrapped as { value })");
});
