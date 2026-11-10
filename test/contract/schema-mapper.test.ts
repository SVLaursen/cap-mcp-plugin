/**
 * M1 — schema-mapper: FieldSpec / EntitySpec / OperationSpec → JSON Schema 2020-12.
 */
import { readModel } from "../../src/model-reader";
import {
  entityInputSchema,
  entityOutputSchema,
  fieldToSchema,
  operationInputSchema,
  operationOutputSchema,
} from "../../src/schema-mapper";
import type { EntitySpec, FieldSpec, ServiceSpec } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";

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

/** Read a snippet and return its one service. */
function serviceOf(source: string): ServiceSpec {
  const [service] = readModel(compileSnippet(source)).spec.services;
  if (!service) throw new Error("expected a service");
  return service;
}

function entityOf(service: ServiceSpec, name: string): EntitySpec {
  const entity = service.entities.find((e) => e.name === name);
  if (!entity) throw new Error(`no entity ${name}`);
  return entity;
}

const books = serviceOf(`
  @mcp service S {
    @mcp.wrap.modes: ['create', 'update', 'delete']
    entity Books {
      key ID: Integer;
      title: String(100) not null;
      @readonly stock: Integer;
      @mcp.omit costPrice: Decimal;
      price: Decimal(9, 2);
    }
  }
`);
const Books = entityOf(books, "S.Books");
const ID = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
const decimal = { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" };

describe("schema-mapper: tool input schemas", () => {
  test("get: required keys only, additionalProperties false", () => {
    expect(entityInputSchema(Books, "get")).toEqual({
      type: "object",
      properties: { ID },
      required: ["ID"],
      additionalProperties: false,
    });
  });

  test("query: where/orderby/select only offer non-omitted scalar fields; top max 200", () => {
    const fields = ["ID", "title", "stock", "price"];
    expect(entityInputSchema(Books, "query")).toEqual({
      type: "object",
      properties: {
        q: { type: "string", description: expect.any(String) },
        where: {
          type: "array",
          description: expect.any(String),
          items: {
            type: "object",
            properties: {
              field: { enum: fields },
              op: {
                enum: [
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
                ],
              },
              value: { description: expect.any(String) },
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
        top: { type: "integer", minimum: 1, maximum: 200, default: 25 },
        cursor: { type: "string", description: expect.any(String) },
      },
      additionalProperties: false,
    });
  });

  test("query: limits come from the caller (cds.env.mcp.limits)", () => {
    const schema = entityInputSchema(Books, "query", { limits: { maxRows: 50, defaultRows: 10 } });
    expect((schema.properties as Record<string, unknown>).top).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 10,
    });
  });

  test("create: readonly fields absent; mandatory fields required", () => {
    expect(entityInputSchema(Books, "create")).toEqual({
      type: "object",
      properties: { ID, title: { type: "string", maxLength: 100 }, price: decimal },
      required: ["title"],
      additionalProperties: false,
    });
  });

  test("update: keys required; every other writable field optional", () => {
    expect(entityInputSchema(Books, "update")).toEqual({
      type: "object",
      properties: { ID, title: { type: "string", maxLength: 100 }, price: decimal },
      required: ["ID"],
      additionalProperties: false,
    });
  });

  test("delete: required keys only", () => {
    expect(entityInputSchema(Books, "delete")).toEqual({
      type: "object",
      properties: { ID },
      required: ["ID"],
      additionalProperties: false,
    });
  });

  test("operation: params mapped; mandatory params required; optional otherwise", () => {
    const service = serviceOf(`
      @mcp service S {
        entity Orders { key ID: Integer; } actions { @mcp action cancel(reason: String); }
        @mcp action order(book: Integer, quantity: Integer @mandatory);
      }
    `);
    const [cancel, order] = service.operations;
    expect(operationInputSchema(order!)).toEqual({
      type: "object",
      properties: { book: ID, quantity: ID },
      required: ["quantity"],
      additionalProperties: false,
    });
    // Bound operations also take the keys of the instance they run on.
    expect(operationInputSchema(cancel!, entityOf(service, "S.Orders"))).toEqual({
      type: "object",
      properties: { ID, reason: { type: "string" } },
      required: ["ID"],
      additionalProperties: false,
    });
  });

  test("deep insert: opted-in compositions appear as arrays of the target's create schema", () => {
    const service = serviceOf(`
      @mcp service S {
        @mcp.wrap.modes: ['create']
        entity Orders {
          key ID: Integer;
          @mcp.deepInsert items: Composition of many Items on items.up_ = $self;
          notes: Composition of many Notes on notes.up_ = $self;
        }
        entity Items { key ID: Integer; up_: Association to Orders; quantity: Integer not null; }
        entity Notes { key ID: Integer; up_: Association to Orders; }
      }
    `);
    const lookup = (name: string) => service.entities.find((e) => e.name === name);
    const schema = entityInputSchema(entityOf(service, "S.Orders"), "create", { entities: lookup });
    expect(schema).toEqual({
      type: "object",
      properties: {
        ID,
        items: {
          type: "array",
          // The back link (up__ID) is filled in by CAP, so the agent never sends it.
          items: {
            type: "object",
            properties: { ID, quantity: ID },
            required: ["quantity"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });
  });
});

describe("schema-mapper: tool output schemas", () => {
  // Non-key, non-mandatory fields may come back as null; Decimal comes back as a string.
  const row = {
    type: "object",
    properties: {
      ID,
      title: { type: "string", maxLength: 100 },
      stock: { ...ID, type: ["integer", "null"] },
      price: { ...decimal, type: ["string", "null"] },
    },
  };

  test("query output is { rows: Entity[], total: integer, nextCursor?: string }", () => {
    expect(entityOutputSchema(Books, "query")).toEqual({
      type: "object",
      properties: {
        rows: { type: "array", items: row },
        total: { type: "integer", minimum: 0 },
        nextCursor: { type: "string" },
      },
      required: ["rows", "total"],
    });
  });

  test("get output is the entity object without omitted fields", () => {
    expect(entityOutputSchema(Books, "get")).toEqual(row);
  });

  test("create and update return the written record; delete returns nothing", () => {
    expect(entityOutputSchema(Books, "create")).toEqual(row);
    expect(entityOutputSchema(Books, "update")).toEqual(row);
    expect(entityOutputSchema(Books, "delete")).toBeUndefined();
  });

  test("a nullable enum allows null among its values", () => {
    const status = field("cds.String", { name: "status", enum: ["O", "C"] });
    const schema = entityOutputSchema({ ...Books, fields: [status] }, "get");
    expect(schema).toEqual({
      type: "object",
      properties: { status: { type: ["string", "null"], enum: ["O", "C", null] } },
    });
  });

  test("operation output follows the CDS return type (scalar wrapped as { value })", () => {
    const service = serviceOf(`
      @mcp service S {
        entity Books { key ID: Integer; @mcp.omit costPrice: Decimal; }
        function count() returns Integer;
        function counts() returns array of Integer;
        function book() returns Books;
        function books() returns array of Books;
        function stock() returns { stock: Integer; };
        @mcp action run();
      }
    `);
    const out = Object.fromEntries(
      service.operations.map((o) => [o.name, operationOutputSchema(o)]),
    );
    const nullableInt = { ...ID, type: ["integer", "null"] };
    const book = { type: "object", properties: { ID } };
    expect(out).toEqual({
      "S.count": { type: "object", properties: { value: nullableInt } },
      "S.counts": { type: "object", properties: { value: { type: "array", items: nullableInt } } },
      "S.book": book,
      // structuredContent must be an object, so lists are wrapped too.
      "S.books": { type: "object", properties: { value: { type: "array", items: book } } },
      "S.stock": { type: "object", properties: { stock: nullableInt } },
      "S.run": undefined,
    });
  });
});
