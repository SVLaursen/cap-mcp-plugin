/**
 * M1 — schema-mapper: FieldSpec / EntitySpec / OperationSpec → JSON Schema 2020-12.
 */
import { readModel } from "../../src/model-reader";
import {
  entityInputSchema,
  elicitationSchema,
  entityOutputSchema,
  fieldToSchema,
  operationInputSchema,
  operationOutputSchema,
  promptArgsSchema,
} from "../../src/schema-mapper";
import type { EntitySpec, FieldSpec, JsonSchema, ServiceSpec } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";
import { schemaError } from "../helpers/validate";

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

  test("Date → string, format date; Time → HH:MM[:SS] pattern; DateTime/Timestamp → date-time", () => {
    expect(fieldToSchema(field("cds.Date"))).toEqual({ type: "string", format: "date" });
    // A pattern, not format "time": RFC 3339 full-time needs a zone; CAP returns "10:00:00".
    expect(fieldToSchema(field("cds.Time"))).toEqual({
      type: "string",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$",
    });
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

  test("Integer64, DecimalFloat and common SAP HANA types map like their CDS counterparts", () => {
    const int64 = fieldToSchema(field("cds.Int64"));
    const decimal = fieldToSchema(field("cds.Decimal"));
    expect(fieldToSchema(field("cds.Integer64"))).toEqual(int64);
    expect(fieldToSchema(field("cds.DecimalFloat"))).toEqual(decimal);
    expect(fieldToSchema(field("cds.hana.SMALLDECIMAL"))).toEqual(decimal);
    expect(fieldToSchema(field("cds.hana.SMALLINT"))).toEqual(fieldToSchema(field("cds.Int16")));
    expect(fieldToSchema(field("cds.hana.TINYINT"))).toEqual(fieldToSchema(field("cds.UInt8")));
    expect(fieldToSchema(field("cds.hana.REAL"))).toEqual({ type: "number" });
    expect(fieldToSchema(field("cds.hana.NCHAR", { length: 3 }))).toEqual({
      type: "string",
      maxLength: 3,
    });
    expect(fieldToSchema(field("cds.Map"))).toEqual({ type: "object" });
  });

  test("values exactly as CAP returns them pass the MCP SDK's validator", () => {
    const samples: [string, unknown][] = [
      ["cds.Time", "10:00:00"],
      ["cds.Date", "2026-11-10"],
      ["cds.DateTime", "2026-11-10T20:11:15Z"],
      ["cds.Timestamp", "2026-11-10T20:11:15.415Z"],
      ["cds.Decimal", "11.11"],
      ["cds.Decimal", "-3"],
      ["cds.Int64", "9007199254740993"],
      ["cds.UUID", "1d0d6a2c-3a8f-4f43-9d0b-6a7d3c1f2e45"],
      ["cds.Boolean", true],
      ["cds.Double", 0.5],
    ];
    expect(
      samples.map(([type, value]) => [type, schemaError(fieldToSchema(field(type)), value)]),
    ).toEqual(samples.map(([type]) => [type, undefined]));
    expect(schemaError(fieldToSchema(field("cds.Time")), "25:00:00")).toBeDefined();
  });

  test("many → array of the item type; the description stays on the array", () => {
    expect(
      fieldToSchema(field("cds.String", { many: true, length: 3, description: "Tags" })),
    ).toEqual({
      type: "array",
      items: { type: "string", maxLength: 3 },
      description: "Tags",
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
// Inputs also accept JSON numbers, which CAP takes as well.
const decimalIn = { ...decimal, type: ["string", "number"] };

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

  test("query: no q when the entity has nothing searchable", () => {
    const service = serviceOf(`@mcp service S { entity Counts { key ID: Integer; n: Integer; } }`);
    const schema = entityInputSchema(entityOf(service, "S.Counts"), "query");
    expect(Object.keys(schema.properties as object)).toEqual([
      "where",
      "orderby",
      "select",
      "top",
      "cursor",
    ]);
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

  test.each([
    ["CAP's limits below ours", { defaultRows: 5, maxRows: 20 }, { maximum: 20, default: 5 }],
    ["only CAP's max: our default, at most that max", { maxRows: 8 }, { maximum: 8, default: 8 }],
    ["only CAP's default", { defaultRows: 40 }, { maximum: 50, default: 40 }],
    [
      "CAP's limits above ours: ours",
      { defaultRows: 100, maxRows: 500 },
      { maximum: 50, default: 50 },
    ],
    ["no CAP limits", undefined, { maximum: 50, default: 10 }],
  ])("query: %s (@cds.query.limit, capped by cds.mcp.limits)", (_name, limits, top) => {
    const schema = entityInputSchema({ ...Books, limits }, "query", {
      limits: { maxRows: 50, defaultRows: 10 },
    });
    expect((schema.properties as Record<string, unknown>).top).toEqual({
      type: "integer",
      minimum: 1,
      ...top,
    });
  });

  test("create: readonly fields absent; mandatory fields required", () => {
    expect(entityInputSchema(Books, "create")).toEqual({
      type: "object",
      properties: { ID, title: { type: "string", maxLength: 100 }, price: decimalIn },
      required: ["title"],
      additionalProperties: false,
    });
  });

  test("update: keys required; every other writable field optional", () => {
    expect(entityInputSchema(Books, "update")).toEqual({
      type: "object",
      properties: { ID, title: { type: "string", maxLength: 100 }, price: decimalIn },
      required: ["ID"],
      additionalProperties: false,
    });
  });

  test("update: a read-only key is still accepted, as the record's address", () => {
    const service = serviceOf(`
      @mcp service S { @mcp.wrap.modes: ['update'] entity T { @readonly key ID: Integer; t: String; } }
    `);
    expect(entityInputSchema(entityOf(service, "S.T"), "update")).toEqual({
      type: "object",
      properties: { ID, t: { type: "string" } },
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

  test("deep insert: a composition of one is an object, and its foreign key is not writable", () => {
    const service = serviceOf(`
      @mcp service S {
        @mcp.wrap.modes: ['create']
        entity Orders { key ID: Integer; @mcp.deepInsert address: Composition of one Addresses; }
        entity Addresses { key ID: Integer; city: String; }
      }
    `);
    const lookup = (name: string) => service.entities.find((e) => e.name === name);
    const schema = entityInputSchema(entityOf(service, "S.Orders"), "create", { entities: lookup });
    expect(schema).toEqual({
      type: "object",
      properties: {
        ID,
        address: {
          type: "object",
          properties: { ID, city: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  test("deep insert: a self-composition nests once, then stops", () => {
    const service = serviceOf(`
      @mcp service S {
        @mcp.wrap.modes: ['create']
        entity Nodes {
          key ID: Integer;
          parent: Association to Nodes;
          @mcp.deepInsert children: Composition of many Nodes on children.parent = $self;
        }
      }
    `);
    const lookup = (name: string) => service.entities.find((e) => e.name === name);
    const schema = entityInputSchema(entityOf(service, "S.Nodes"), "create", { entities: lookup });
    expect(schema).toEqual({
      type: "object",
      properties: {
        ID,
        parent_ID: ID,
        children: {
          type: "array",
          items: { type: "object", properties: { ID }, additionalProperties: false },
        },
      },
      additionalProperties: false,
    });
  });

  test("deep insert: only the back link is left to CAP, not other links to the parent type", () => {
    const service = serviceOf(`
      @mcp service S {
        @mcp.wrap.modes: ['create']
        entity Orders {
          key ID: Integer;
          @mcp.deepInsert items: Composition of many Items on items.up_ = $self;
        }
        entity Items { key ID: Integer; up_: Association to Orders; replaces: Association to Orders; }
      }
    `);
    const lookup = (name: string) => service.entities.find((e) => e.name === name);
    const schema = entityInputSchema(entityOf(service, "S.Orders"), "create", { entities: lookup });
    const items = (schema.properties as Record<string, JsonSchema>).items as JsonSchema;
    expect(Object.keys((items.items as JsonSchema).properties as object)).toEqual([
      "ID",
      "replaces_ID",
    ]);
  });

  test("deep insert: update accepts the same nested children as create", () => {
    const service = serviceOf(`
      @mcp service S {
        @mcp.wrap.modes: ['update']
        entity Orders {
          key ID: Integer;
          @mcp.deepInsert items: Composition of many Items on items.up_ = $self;
        }
        entity Items { key ID: Integer; up_: Association to Orders; qty: Integer; }
      }
    `);
    const lookup = (name: string) => service.entities.find((e) => e.name === name);
    const schema = entityInputSchema(entityOf(service, "S.Orders"), "update", { entities: lookup });
    expect(schema).toEqual({
      type: "object",
      properties: {
        ID,
        items: {
          type: "array",
          items: { type: "object", properties: { ID, qty: ID }, additionalProperties: false },
        },
      },
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

  test("create and update return the written record; delete returns the deleted key", () => {
    expect(entityOutputSchema(Books, "create")).toEqual(row);
    expect(entityOutputSchema(Books, "update")).toEqual(row);
    expect(entityOutputSchema(Books, "delete")).toEqual({
      type: "object",
      properties: { deleted: { type: "object", properties: { ID }, required: ["ID"] } },
      required: ["deleted"],
    });
  });

  test("only keys and not null fields are non-null in output; @mandatory is checked on input only", () => {
    const service = serviceOf(`
      @mcp service S { entity T { key ID: Integer; a: String not null; @mandatory b: String; } }
    `);
    expect(entityOutputSchema(entityOf(service, "S.T"), "get")).toEqual({
      type: "object",
      properties: { ID, a: { type: "string" }, b: { type: ["string", "null"] } },
    });
  });

  test("a nullable enum allows null among its values", () => {
    const status = field("cds.String", { name: "status", enum: ["O", "C"] });
    const schema = entityOutputSchema({ ...Books, fields: [status] }, "get");
    expect(schema).toEqual({
      type: "object",
      properties: { status: { type: ["string", "null"], enum: ["O", "C", null] } },
    });
  });

  test("operation output follows the CDS return type, always wrapped as { value }", () => {
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
    const value = (schema: JsonSchema) => ({ type: "object", properties: { value: schema } });
    // Always { value }: one shape for every operation, an object for 2025-era clients, and a
    // single record may be null (nothing found) without failing output validation.
    expect(out).toEqual({
      "S.count": value(nullableInt),
      "S.counts": value({ type: "array", items: nullableInt }),
      "S.book": value({ ...book, type: ["object", "null"] }),
      "S.books": value({ type: "array", items: book }),
      "S.stock": value({ type: ["object", "null"], properties: { stock: nullableInt } }),
      "S.run": undefined,
    });
  });
});

describe("schema-mapper: prompt arguments", () => {
  test("every input is a required string; numbers and booleans must look like one", () => {
    const prompt = {
      name: "p",
      service: "S",
      template: "{{n}} {{d}} {{b}} {{s}}",
      role: "user" as const,
      inputs: [
        { key: "n", type: "Integer" },
        { key: "d", type: "cds.Decimal" },
        { key: "b", type: "Boolean" },
        { key: "s", type: "String" },
      ],
    };
    expect(promptArgsSchema(prompt)).toEqual({
      type: "object",
      properties: {
        n: { type: "string", pattern: "^-?\\d+$" },
        d: { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" },
        b: { enum: ["true", "false"] },
        s: { type: "string" },
      },
      required: ["n", "d", "b", "s"],
      additionalProperties: false,
    });
  });
});

describe("schema-mapper: confirmation forms (@mcp.elicit)", () => {
  const [service] = readModel(
    compileSnippet(`@mcp service S {
      @mcp @mcp.elicit: ['confirm'] action go(n: Integer);
      @mcp @mcp.elicit: ['confirm', 'n', 'note', 'when', 'list', 'size']
      action edit(n: Integer @mandatory, note: String(20), when: Date, list: array of String,
                  size: String enum { S; M; }, other: Boolean);
    }`),
  ).spec.services;
  const op = (name: string) => {
    const found = service?.operations.find((o) => o.name === `S.${name}`);
    if (!found) throw new Error(`no S.${name}`);
    return found;
  };

  test("['confirm'] asks for nothing but the user's yes", () => {
    expect(elicitationSchema(op("go"), { n: 1 })).toEqual({ type: "object", properties: {} });
  });

  test("parameter names are asked for, pre-filled with the agent's values", () => {
    expect(elicitationSchema(op("edit"), { n: 3, note: "hi", other: true })).toEqual({
      type: "object",
      properties: {
        n: { type: "integer", minimum: -2147483648, maximum: 2147483647, default: 3 },
        note: { type: "string", maxLength: 20, default: "hi" },
        when: { type: "string", format: "date" },
        // Arrays cannot be asked for in a form; the agent's value stands.
        size: { type: "string", enum: ["S", "M"] },
      },
      required: ["n"],
    });
  });
});
