/**
 * M1 — schema-mapper: FieldSpec / EntitySpec / OperationSpec → JSON Schema 2020-12.
 */
import { fieldToSchema } from "../../src/schema-mapper";
import type { FieldSpec } from "../../src/types";

/** A plain, optional, writable field of the given CDS type. */
function field(cdsType: string, extra: Partial<FieldSpec> = {}): FieldSpec {
  return {
    name: "f",
    cdsType,
    key: false,
    mandatory: false,
    readonly: false,
    completion: false,
    ...extra,
  };
}

describe("schema-mapper: scalar types", () => {
  test("String → string with maxLength from length", () => {
    expect(fieldToSchema(field("cds.String", { length: 100 }))).toEqual({
      type: "string",
      maxLength: 100,
    });
    expect(fieldToSchema(field("cds.String"))).toEqual({ type: "string" });
    expect(fieldToSchema(field("cds.LargeString"))).toEqual({ type: "string" });
  });

  test("Integer, Int16, Int32, UInt8 → integer with the type's bounds", () => {
    const int32 = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    expect(fieldToSchema(field("cds.Integer"))).toEqual(int32);
    expect(fieldToSchema(field("cds.Int32"))).toEqual(int32);
    expect(fieldToSchema(field("cds.Int16"))).toEqual({
      type: "integer",
      minimum: -32768,
      maximum: 32767,
    });
    expect(fieldToSchema(field("cds.UInt8"))).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 255,
    });
  });

  test("Int64 and Decimal → string with a numeric pattern (precision-safe)", () => {
    expect(fieldToSchema(field("cds.Int64"))).toEqual({ type: "string", pattern: "^-?\\d+$" });
    expect(fieldToSchema(field("cds.Decimal", { precision: 9, scale: 2 }))).toEqual({
      type: "string",
      pattern: "^-?\\d+(\\.\\d+)?$",
    });
  });

  test("Double → number", () => {
    expect(fieldToSchema(field("cds.Double"))).toEqual({ type: "number" });
  });

  test("Boolean → boolean", () => {
    expect(fieldToSchema(field("cds.Boolean"))).toEqual({ type: "boolean" });
  });

  test("UUID → string, format uuid", () => {
    expect(fieldToSchema(field("cds.UUID"))).toEqual({ type: "string", format: "uuid" });
  });

  test("Date → string, format date; Time → time; DateTime/Timestamp → date-time", () => {
    expect(fieldToSchema(field("cds.Date"))).toEqual({ type: "string", format: "date" });
    expect(fieldToSchema(field("cds.Time"))).toEqual({ type: "string", format: "time" });
    expect(fieldToSchema(field("cds.DateTime"))).toEqual({ type: "string", format: "date-time" });
    expect(fieldToSchema(field("cds.Timestamp"))).toEqual({ type: "string", format: "date-time" });
  });

  test("enum → enum of the declared values", () => {
    expect(fieldToSchema(field("cds.String", { length: 1, enum: ["O", "C"] }))).toEqual({
      type: "string",
      maxLength: 1,
      enum: ["O", "C"],
    });
    expect(fieldToSchema(field("cds.Integer", { enum: [1, 3] }))).toEqual({
      type: "integer",
      enum: [1, 3],
    });
  });

  test("@assert.range → minimum/maximum", () => {
    expect(fieldToSchema(field("cds.Integer", { range: [0, 100] }))).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
    });
    // An open bound keeps the type's own bound.
    expect(fieldToSchema(field("cds.UInt8", { range: [undefined, 10] }))).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 10,
    });
    expect(fieldToSchema(field("cds.Double", { range: [0.5, undefined] }))).toEqual({
      type: "number",
      minimum: 0.5,
    });
  });

  test("description is copied when present", () => {
    expect(fieldToSchema(field("cds.Boolean", { description: "In stock" }))).toEqual({
      type: "boolean",
      description: "In stock",
    });
  });
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
