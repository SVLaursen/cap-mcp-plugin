/**
 * M1 — model-reader: CSN + @mcp annotations → ExposureSpec.
 * Spec: docs/annotations.md. Turn each todo into a real test (red), then implement (green).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readModel } from "../../src/model-reader";
import type { Diagnostic, ExposureSpec, FieldSpec, ServiceSpec } from "../../src/types";
import { compileDemo, compileSnippet } from "../helpers/snippet";

describe("model-reader: doc comments (ADR 0011)", () => {
  const source = `
    /** Browse the book catalogue */
    @title: 'Catalogue'
    @mcp service CatalogService {}
  `;
  const service = (description: string | undefined) => ({
    name: "CatalogService",
    title: "Catalogue",
    description,
    compact: false,
    describe: false,
    entities: [],
    operations: [],
    prompts: [],
  });

  test("with cdsc.docs on, a doc comment becomes the description", () => {
    const { spec } = readModel(compileSnippet(source, { docs: true }));
    expect(spec).toEqual({ services: [service("Browse the book catalogue")] });
  });

  test("with cdsc.docs off, the description falls back to @title", () => {
    const { spec } = readModel(compileSnippet(source, { docs: false }));
    expect(spec).toEqual({ services: [service("Catalogue")] });
  });

  test("the plugin does not switch cdsc.docs on for the app", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    expect(pkg.cds?.cdsc?.docs).toBeUndefined();
  });
});

/** What a spec exposes, per service: entity modes and operation names. Hides field details. */
function exposed(spec: ExposureSpec) {
  return Object.fromEntries(
    spec.services.map((s) => [
      s.name,
      {
        entities: Object.fromEntries(s.entities.map((e) => [e.name, [...e.modes].sort()])),
        operations: s.operations.map((o) => o.name),
      },
    ]),
  );
}

/** The one service a snippet declares; fails the test if there is not exactly one. */
function onlyService(spec: ExposureSpec): ServiceSpec {
  const [service, ...rest] = spec.services;
  if (!service || rest.length) throw new Error(`expected one service, got ${spec.services.length}`);
  return service;
}

describe("model-reader: opt-in", () => {
  test("a model without any @mcp annotation produces an empty spec and no diagnostics", () => {
    const csn = compileSnippet(`
      service S {
        entity Books { key ID: Integer; }
        function f() returns Integer;
        action a();
      }
    `);
    expect(readModel(csn)).toEqual({ spec: { services: [] }, diagnostics: [] });
  });

  test("@mcp on a service exposes every entity with modes {query, get} and nothing else", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; title: localized String; }
        @odata.draft.enabled entity Orders { key ID: UUID; }
      }
    `);
    // CAP-generated entities (Books.texts, DraftAdministrativeData) are not declared, so not exposed.
    expect(exposed(readModel(csn).spec)).toEqual({
      S: {
        entities: { "S.Books": ["get", "query"], "S.Orders": ["get", "query"] },
        operations: [],
      },
    });
  });

  test("@mcp on a service exposes every function (bound and unbound)", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; } actions { function price() returns Decimal; }
        function count() returns Integer;
      }
    `);
    const { operations } = onlyService(readModel(csn).spec);
    expect(operations.map(({ name, kind, boundTo }) => ({ name, kind, boundTo }))).toEqual([
      { name: "S.Books.price", kind: "function", boundTo: "S.Books" },
      { name: "S.count", kind: "function", boundTo: undefined },
    ]);
  });

  test("@mcp on a service does NOT expose actions without their own @mcp", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; } actions { action reprice(); @mcp action archive(); }
        action restock();
        @mcp action order();
      }
    `);
    expect(onlyService(readModel(csn).spec).operations.map((o) => o.name)).toEqual([
      "S.Books.archive",
      "S.order",
    ]);
  });

  test("@mcp on an action exposes it even when the service has no @mcp", () => {
    const csn = compileSnippet(`
      service S {
        entity Books { key ID: Integer; }
        function count() returns Integer;
        @mcp action order();
      }
    `);
    expect(exposed(readModel(csn).spec)).toEqual({ S: { entities: {}, operations: ["S.order"] } });
  });

  test("@mcp on a single entity exposes only that entity, with modes {query, get}", () => {
    const csn = compileSnippet(`
      service S {
        @mcp entity Books { key ID: Integer; } actions { function price() returns Decimal; }
        entity Authors { key ID: Integer; }
      }
    `);
    expect(exposed(readModel(csn).spec)).toEqual({
      S: { entities: { "S.Books": ["get", "query"] }, operations: [] },
    });
  });

  test("@mcp: false on an entity removes it from an @mcp service", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; }
        @mcp: false entity Notes { key ID: Integer; } actions { function f() returns Integer; }
      }
    `);
    expect(exposed(readModel(csn).spec)).toEqual({
      S: { entities: { "S.Books": ["get", "query"] }, operations: [] },
    });
  });

  test("@mcp: false on an operation removes it from an @mcp service", () => {
    const csn = compileSnippet(`@mcp service S { @mcp: false function f() returns Integer; }`);
    expect(exposed(readModel(csn).spec)).toEqual({ S: { entities: {}, operations: [] } });
  });

  test("annotations CAP copies from another layer take effect only in @mcp services", () => {
    const csn = compileSnippet(`
      namespace db;
      @mcp @mcp.wrap.modes: ['delete']
      entity Books { key ID: Integer; title: String; @mcp.omit costPrice: Decimal; }
      entity Authors { key ID: Integer; }
      service Admin { entity Books as projection on db.Books; }
      @mcp service Catalog { entity Books as projection on db.Books; }
      service Shop {
        @mcp entity Authors as projection on db.Authors;
        @mcp entity Books as projection on db.Books;
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    // Admin never says @mcp, so the copied @mcp / @mcp.wrap.modes expose nothing there and are
    // not reported as unused either. Catalog is an MCP service: everything copied applies.
    // Shop opts Authors in itself. Its @mcp on Books equals the copied one, so it cannot be
    // told apart from it and counts as copied.
    expect(exposed(spec)).toEqual({
      "db.Catalog": {
        entities: { "db.Catalog.Books": ["delete", "get", "query"] },
        operations: [],
      },
      "db.Shop": { entities: { "db.Shop.Authors": ["get", "query"] }, operations: [] },
    });
    expect(spec.services[0]?.entities[0]?.fields.map((f) => f.name)).toEqual(["ID", "title"]);
    expect(diagnostics).toEqual([]);
  });

  test("@mcp: false on a service switches the whole service off, even opted-in members", () => {
    const csn = compileSnippet(`
      @mcp: false service S {
        @mcp entity Books { key ID: Integer; }
        @mcp action order();
      }
    `);
    expect(readModel(csn).spec).toEqual({ services: [] });
  });

  test("an explicit @mcp exposes an entity CAP generated, which the baseline skips", () => {
    const csn = compileSnippet(`
      @mcp service S { entity Books { key ID: Integer; title: localized String; } }
      annotate S.Books.texts with @mcp;
    `);
    expect(Object.keys(exposed(readModel(csn).spec).S?.entities ?? {})).toEqual([
      "S.Books",
      "S.Books.texts",
    ]);
  });

  test("@cds.api.ignore on an entity or element removes it", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; title: String; @cds.api.ignore internal: String; }
        @cds.api.ignore entity Notes { key ID: Integer; }
      }
    `);
    const { entities } = onlyService(readModel(csn).spec);
    expect(entities.map((e) => [e.name, e.fields.map((f) => f.name)])).toEqual([
      ["S.Books", ["ID", "title"]],
    ]);
  });

  test("@mcp.omit elements never appear in fields or keys", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books {
          key ID: Integer;
          @mcp.omit key edition: Integer;
          title: String;
          @mcp.omit costPrice: Decimal;
          @mcp.omit author: Association to Authors;
        }
        entity Authors { key ID: Integer; }
        entity Listings as projection on Books;
      }
    `);
    const names = (fields: FieldSpec[]) => fields.map((f) => f.name);
    const { entities } = onlyService(readModel(csn).spec);
    // CAP carries @mcp.omit to the generated foreign key (author_ID) and through projections.
    expect(entities.map((e) => [e.name, names(e.keys), names(e.fields)])).toEqual([
      ["S.Books", ["ID"], ["ID", "title"]],
      ["S.Authors", ["ID"], ["ID"]],
      ["S.Listings", ["ID"], ["ID", "title"]],
    ]);
  });
  test("@mcp.wrap.modes adds the listed write modes to query/get; unknown modes are diagnostics", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.wrap.modes: ['create', 'upsert'] entity Books { key ID: Integer; }
        entity Authors { key ID: Integer; }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(exposed(spec).S?.entities).toEqual({
      "S.Books": ["create", "get", "query"],
      "S.Authors": ["get", "query"],
    });
    expect(diagnostics).toEqual([
      {
        level: "error",
        code: "INVALID_ANNOTATION_VALUE",
        target: "S.Books",
        message: expect.stringContaining('"upsert"'),
      },
    ]);
  });

  test("@mcp.resource marks the entity as resource; no other annotation does", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.resource entity Authors { key ID: Integer; }
        @mcp.wrap.modes: ['create', 'update', 'delete'] entity Books { key ID: Integer; }
      }
    `);
    const { entities } = onlyService(readModel(csn).spec);
    expect(entities.map((e) => [e.name, e.resource])).toEqual([
      ["S.Authors", true],
      ["S.Books", false],
    ]);
  });

  test("@mcp.prompts on a service produces PromptSpecs; prompts are not created otherwise", () => {
    const csn = compileSnippet(`
      @mcp
      @mcp.prompts: [{
        name: 'restock-plan', title: 'Restock plan', description: 'Suggest restocks',
        template: 'Books below {{threshold}}', role: 'user',
        inputs: [{ key: 'threshold', type: 'Integer' }]
      }]
      service S {}
      @mcp service T {}
    `);
    const { services } = readModel(csn).spec;
    expect(services.map((s) => [s.name, s.prompts])).toEqual([
      [
        "S",
        [
          {
            name: "restock-plan",
            service: "S",
            title: "Restock plan",
            description: "Suggest restocks",
            template: "Books below {{threshold}}",
            role: "user",
            inputs: [{ key: "threshold", type: "Integer" }],
          },
        ],
      ],
      ["T", []],
    ]);
  });

  test("@mcp.ui on an operation sets ui to the ui:// URI; a non-ui:// value is a diagnostic", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.ui: 'ui://shop/card.html' function card() returns Integer;
        @mcp.ui: 'https://example.com/card.html' function page() returns Integer;
        function plain() returns Integer;
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(onlyService(spec).operations.map((o) => [o.name, o.ui])).toEqual([
      ["S.card", "ui://shop/card.html"],
      ["S.page", undefined],
      ["S.plain", undefined],
    ]);
    expect(diagnostics).toEqual([
      {
        level: "error",
        code: "INVALID_ANNOTATION_VALUE",
        target: "S.page",
        message: expect.stringContaining("ui://"),
      },
    ]);
  });

  test("@mcp.elicit on an operation sets elicit", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Orders { key ID: Integer; } actions {
          @mcp @mcp.elicit: ['confirm'] action cancel(reason: String);
        }
        @mcp action order();
      }
    `);
    expect(onlyService(readModel(csn).spec).operations.map((o) => [o.name, o.elicit])).toEqual([
      ["S.Orders.cancel", ["confirm"]],
      ["S.order", undefined],
    ]);
  });

  test("@mcp.completion on an element or parameter sets completion: true", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; @mcp.completion genre: String; title: String; }
        @mcp action order(@mcp.completion book: Integer, quantity: Integer);
      }
    `);
    const service = onlyService(readModel(csn).spec);
    const completion = (fields: FieldSpec[]) => fields.map((f) => [f.name, f.completion]);
    expect(service.entities.map((e) => completion(e.fields))).toEqual([
      [
        ["ID", false],
        ["genre", true],
        ["title", false],
      ],
    ]);
    expect(service.operations.map((o) => completion(o.params))).toEqual([
      [
        ["book", true],
        ["quantity", false],
      ],
    ]);
  });

  test("@mcp.completion has an effect only on the single key of an @mcp.resource entity", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.resource entity Authors { key ID: Integer @mcp.completion; name: String; }
        entity Books { key ID: Integer @mcp.completion; @mcp.completion genre: String; }
        @mcp.resource entity Pairs { key a: String @mcp.completion; key b: Integer; }
        @mcp action order(@mcp.completion book: Integer);
      }
    `);
    const unused = readModel(csn).diagnostics.filter((d) => d.code === "UNUSED_ANNOTATION");
    expect(unused.map((d) => d.target).sort()).toEqual([
      "S.Books:ID",
      "S.Books:genre",
      "S.Pairs:a",
      "S.order:book",
    ]);
    // MCP completes prompt arguments and resource-template variables, never tool arguments.
    expect(unused.find((d) => d.target === "S.order:book")).toMatchObject({
      level: "warn",
      message: expect.stringMatching(/tool arguments/),
    });
  });

  test("@mcp.describe on a service sets describe: true; default is false", () => {
    const csn = compileSnippet(`@mcp @mcp.describe service S {} @mcp service T {}`);
    expect(readModel(csn).spec.services.map((s) => [s.name, s.describe])).toEqual([
      ["S", true],
      ["T", false],
    ]);
  });

  test("@mcp.compact on a service sets compact: true; default is false", () => {
    const csn = compileSnippet(`@mcp @mcp.compact service S {} @mcp service T {}`);
    expect(readModel(csn).spec.services.map((s) => [s.name, s.compact])).toEqual([
      ["S", true],
      ["T", false],
    ]);
  });

  test("@mcp.deepInsert on a composition element lists it, with its target, in deepInsert", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Orders {
          key ID: Integer;
          @mcp.deepInsert items: Composition of many Items on items.up_ = $self;
          notes: Composition of many Notes on notes.up_ = $self;
        }
        entity Items { key ID: Integer; up_: Association to Orders; }
        entity Notes { key ID: Integer; up_: Association to Orders; }
      }
    `);
    const { entities } = onlyService(readModel(csn).spec);
    expect(entities.map((e) => [e.name, e.deepInsert])).toEqual([
      ["S.Orders", [{ element: "items", target: "S.Items", many: true, backlink: "up_" }]],
      ["S.Items", []],
      ["S.Notes", []],
    ]);
  });

  test("draft entities never expose CAP's draft bookkeeping elements as fields or keys", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @odata.draft.enabled entity Orders {
          key ID: UUID;
          note: String;
          items: Composition of many Items on items.up_ = $self;
        }
        entity Items { key ID: UUID; up_: Association to Orders; qty: Integer; }
      }
    `);
    const { entities } = onlyService(readModel(csn).spec);
    expect(
      entities.map((e) => [e.name, e.keys.map((k) => k.name), e.fields.map((f) => f.name)]),
    ).toEqual([
      ["S.Orders", ["ID"], ["ID", "note"]],
      ["S.Items", ["ID"], ["ID", "up__ID", "qty"]],
    ]);
  });

  test("draft-enabled entities, and the compositions inside them, have draft: true", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @odata.draft.enabled entity Orders {
          key ID: UUID;
          items: Composition of many Items on items.up_ = $self;
        }
        entity Items { key ID: UUID; up_: Association to Orders; }
        entity Books { key ID: Integer; }
      }
    `);
    const { entities } = onlyService(readModel(csn).spec);
    expect(entities.map((e) => [e.name, e.draft, e.draftRoot])).toEqual([
      ["S.Orders", true, true],
      ["S.Items", true, undefined],
      ["S.Books", false, undefined],
    ]);
  });
});

describe("model-reader: names and descriptions", () => {
  /** Every exposed definition, flattened, with the name/description pair under test. */
  function labels(
    spec: ExposureSpec,
    pick: (d: { title?: string; description?: string }) => unknown,
  ) {
    return Object.fromEntries(
      spec.services.flatMap((s) => [
        [s.name, pick(s)],
        ...s.entities.map((e) => [e.name, pick(e)]),
        ...s.operations.map((o) => [o.name, pick(o)]),
      ]),
    );
  }

  test("description falls back: @mcp.description → @description → doc comment → @title → none", () => {
    const csn = compileSnippet(`
      /** doc S */ @mcp.description: 'mcp S' @description: 'cds S' @title: 'Title S'
      @mcp service S {
        /** doc A */ @description: 'cds A' @title: 'Title A' entity A { key ID: Integer; }
        /** doc B */ @title: 'Title B' entity B { key ID: Integer; }
        @title: 'Title C' entity C { key ID: Integer; }
        entity D { key ID: Integer; }
        /** doc f */ @mcp.description: 'mcp f' function f() returns Integer;
      }
    `);
    expect(labels(readModel(csn).spec, (d) => d.description)).toEqual({
      S: "mcp S",
      "S.A": "cds A",
      "S.B": "doc B",
      "S.C": "Title C",
      "S.D": undefined,
      "S.f": "mcp f",
    });
  });

  test("title falls back: @mcp.name → @title → definition name", () => {
    const csn = compileSnippet(`
      @mcp.name: 'Shop' @title: 'Shop service'
      @mcp service S {
        @title: 'Books' entity A { key ID: Integer; }
        entity B { key ID: Integer; }
        @mcp.name: 'Count books' function f() returns Integer;
        @title: 'Stock' function g() returns Integer;
        function h() returns Integer;
      }
    `);
    expect(labels(readModel(csn).spec, (d) => d.title)).toEqual({
      S: "Shop",
      "S.A": "Books",
      "S.B": "S.B",
      "S.f": "Count books",
      "S.g": "Stock",
      "S.h": "S.h",
    });
  });

  test("unresolved {i18n>…} texts are treated as absent, never shown to agents", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @title: '{i18n>Books}' entity Books {
          key ID: Integer;
          @title: '{i18n>CreatedBy}' @description: '{i18n>UserID.Description}' createdBy: String;
        }
      }
    `);
    const [books] = onlyService(readModel(csn).spec).entities;
    expect(books?.title).toBe("S.Books");
    expect(books?.description).toBeUndefined();
    expect(books?.fields.find((f) => f.name === "createdBy")?.description).toBeUndefined();
  });

  test("element descriptions use @mcp.hint → @description → doc comment", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books {
          key ID: Integer;
          /** doc a */ @mcp.hint: 'hint a' @description: 'cds a' a: String;
          /** doc b */ @description: 'cds b' b: String;
          /** doc c */ @title: 'Title c' c: String;
          @title: 'Title d' d: String;
        }
        @mcp action order(/** doc p */ @mcp.hint: 'hint p' p: Integer, /** doc q */ q: Integer);
      }
    `);
    const service = onlyService(readModel(csn).spec);
    const hints = (fields: FieldSpec[]) => fields.map((f) => [f.name, f.description]);
    expect(service.entities.map((e) => hints(e.fields))).toEqual([
      [
        ["ID", undefined],
        ["a", "hint a"],
        ["b", "cds b"],
        ["c", "doc c"],
        ["d", undefined],
      ],
    ]);
    expect(service.operations.map((o) => hints(o.params))).toEqual([
      [
        ["p", "hint p"],
        ["q", "doc q"],
      ],
    ]);
  });
});

describe("model-reader: field shapes", () => {
  /** The fields of the one entity a snippet's service declares first. */
  function fieldsOf(source: string): FieldSpec[] {
    const [entity] = onlyService(readModel(compileSnippet(source)).spec).entities;
    if (!entity) throw new Error("expected an entity");
    return entity.fields;
  }
  const pick = <K extends keyof FieldSpec>(fields: FieldSpec[], key: K) =>
    fields.map((f) => [f.name, f[key]]);

  test("keys are FieldSpecs with key: true, in declaration order", () => {
    const csn = compileSnippet(`
      @mcp service S { entity Editions { key isbn: String(13); title: String; key edition: Integer; } }
    `);
    const [entity] = onlyService(readModel(csn).spec).entities;
    expect(entity?.keys).toEqual([
      {
        name: "isbn",
        cdsType: "cds.String",
        key: true,
        mandatory: false,
        readonly: false,
        length: 13,
        completion: false,
      },
      {
        name: "edition",
        cdsType: "cds.Integer",
        key: true,
        mandatory: false,
        readonly: false,
        completion: false,
      },
    ]);
  });

  test("@mandatory and not null set mandatory: true", () => {
    const fields = fieldsOf(`
      @mcp service S { entity Books { key ID: Integer; title: String not null; @mandatory descr: String; note: String; } }
    `);
    expect(pick(fields, "mandatory")).toEqual([
      ["ID", false],
      ["title", true],
      ["descr", true],
      ["note", false],
    ]);
  });

  test("@readonly, @Core.Computed and managed fields set readonly: true", () => {
    const fields = fieldsOf(`
      aspect managed {
        createdAt: Timestamp @cds.on.insert: $now;
        modifiedAt: Timestamp @cds.on.insert: $now @cds.on.update: $now;
      }
      @mcp service S {
        entity Books : managed {
          key ID: Integer;
          @readonly stock: Integer;
          @Core.Computed total: Decimal;
          virtual rating: Integer;
          title: String;
        }
      }
    `);
    expect(pick(fields, "readonly")).toEqual([
      ["createdAt", true],
      ["modifiedAt", true],
      ["ID", false],
      ["stock", true],
      ["total", true],
      ["rating", true],
      ["title", false],
    ]);
  });

  test("enum types list their values; length, precision, scale and @assert.range are carried", () => {
    const fields = fieldsOf(`
      type Status : String(1) enum { open = 'O'; closed = 'C'; }
      @mcp service S {
        entity Books {
          key ID: Integer;
          status: Status;
          level: Integer enum { low = 1; high = 3; };
          colour: String enum { red; green; };
          price: Decimal(9, 2);
          @assert.range: [0, 100] pct: Integer;
          @assert.range: [_, 10] capped: Integer;
        }
      }
    `);
    const shape = ({ name, enum: values, length, precision, scale, range }: FieldSpec) => ({
      name,
      ...(values && { enum: values }),
      ...(length !== undefined && { length }),
      ...(precision !== undefined && { precision, scale }),
      ...(range && { range }),
    });
    expect(fields.map(shape)).toEqual([
      { name: "ID" },
      { name: "status", enum: ["O", "C"], length: 1 },
      { name: "level", enum: [1, 3] },
      { name: "colour", enum: ["red", "green"] },
      { name: "price", precision: 9, scale: 2 },
      { name: "pct", range: [0, 100] },
      { name: "capped", range: [undefined, 10] },
    ]);
  });

  test("managed associations appear as their foreign key fields with target set", () => {
    const fields = fieldsOf(`
      @mcp service S {
        entity Books { key ID: Integer; author: Association to Authors; genre: Association to Genres; }
        entity Authors { key ID: Integer; }
        entity Genres { key code: String; key lang: String; }
      }
    `);
    expect(pick(fields, "target")).toEqual([
      ["ID", undefined],
      ["author_ID", "S.Authors"],
      ["genre_code", "S.Genres"],
      ["genre_lang", "S.Genres"],
    ]);
  });

  test("operation parameters typed as Entity:element resolve to the element's builtin type", () => {
    const csn = compileSnippet(`
      type Status : String(1) enum { open = 'O'; closed = 'C'; }
      @mcp service S {
        entity Books { key ID: Integer; status: Status; }
        @mcp action order(book: Books:ID, status: Books:status, quantity: Integer not null);
      }
    `);
    const [order] = onlyService(readModel(csn).spec).operations;
    expect(order?.params).toEqual([
      {
        name: "book",
        cdsType: "cds.Integer",
        key: false,
        mandatory: false,
        readonly: false,
        completion: false,
      },
      {
        name: "status",
        cdsType: "cds.String",
        key: false,
        mandatory: false,
        readonly: false,
        enum: ["O", "C"],
        length: 1,
        completion: false,
      },
      {
        name: "quantity",
        cdsType: "cds.Integer",
        key: false,
        mandatory: true,
        notNull: true,
        readonly: false,
        completion: false,
      },
    ]);
  });
});

describe("model-reader: authorization metadata", () => {
  test("@requires on services, entities and operations is carried as a role list", () => {
    const csn = compileSnippet(`
      @requires: 'admin' @mcp service S {
        @requires: ['support', 'admin'] entity Tickets { key ID: Integer; }
          actions { @requires: 'admin' @mcp action close(); }
        entity Open { key ID: Integer; }
        @requires: 'authenticated-user' function mine() returns Integer;
      }
      @mcp service T {}
    `);
    const { services } = readModel(csn).spec;
    const [s, t] = services;
    expect(t?.requires).toBeUndefined();
    expect(s?.requires).toEqual(["admin"]);
    expect(s?.entities.map((e) => [e.name, e.requires])).toEqual([
      ["S.Tickets", ["support", "admin"]],
      ["S.Open", undefined],
    ]);
    expect(s?.operations.map((o) => [o.name, o.requires])).toEqual([
      ["S.Tickets.close", ["admin"]],
      ["S.mine", ["authenticated-user"]],
    ]);
  });
});

describe("model-reader: search columns", () => {
  const search = (source: string) =>
    Object.fromEntries(
      onlyService(readModel(compileSnippet(source)).spec).entities.map((e) => [e.name, e.search]),
    );

  test("without @cds.search entries set to true: every plain String element except @mcp.omit and false ones", () => {
    expect(
      search(`
        @mcp service S {
          @cds.search: { born: false }
          entity Authors {
            key ID: Integer; name: String; bio: LargeString; @mcp.omit email: String;
            virtual nick: String; age: Integer; born: String;
          }
        }
      `),
    ).toEqual({ "S.Authors": ["name"] });
  });

  test("with @cds.search: only the listed elements; associations expand to their target's", () => {
    expect(
      search(`
        @mcp service S {
          @cds.search: { title, author }
          entity Books { key ID: Integer; title: String; descr: String; author: Association to Authors; }
          entity Authors { key ID: Integer; name: String; @mcp.omit email: String; }
        }
      `)["S.Books"],
    ).toEqual(["title", "author.name"]);
  });

  test("an @mcp.omit element listed in @cds.search is still not searched", () => {
    expect(
      search(`
        @mcp service S {
          @cds.search: { title, secret }
          entity Notes { key ID: Integer; title: String; @mcp.omit secret: String; }
        }
      `),
    ).toEqual({ "S.Notes": ["title"] });
  });
});

describe("model-reader: row limits (CAP's @cds.query.limit)", () => {
  const read = (source: string) => readModel(compileSnippet(source));
  const limits = (source: string) =>
    Object.fromEntries(onlyService(read(source).spec).entities.map((e) => [e.name, e.limits]));

  test("the entity's default and max, as CAP reads them", () => {
    expect(
      limits(`
        @mcp service S {
          @cds.query.limit: { default: 2, max: 3 } entity A { key ID: Integer; }
          @cds.query.limit: 10 entity B { key ID: Integer; }
          entity C { key ID: Integer; }
        }
      `),
    ).toEqual({
      "S.A": { defaultRows: 2, maxRows: 3 },
      "S.B": { defaultRows: 10 },
      "S.C": undefined,
    });
  });

  test("the service's limit applies where the entity sets none, key by key", () => {
    expect(
      limits(`
        @mcp @cds.query.limit: { default: 20, max: 50 } service S {
          @cds.query.limit.max: 30 entity A { key ID: Integer; }
          entity B { key ID: Integer; }
        }
      `),
    ).toEqual({ "S.A": { defaultRows: 20, maxRows: 30 }, "S.B": { defaultRows: 20, maxRows: 50 } });
  });

  test("the entity's bare @cds.query.limit (its default) wins over the service's default", () => {
    expect(
      limits(`
        @mcp @cds.query.limit: { default: 20, max: 50 } service S {
          @cds.query.limit: 5 entity A { key ID: Integer; }
        }
      `),
    ).toEqual({ "S.A": { defaultRows: 5, maxRows: 50 } });
  });

  test("a bad value on the service is reported once, on the service", () => {
    const { diagnostics } = read(`
      @mcp @cds.query.limit: 'ten' service S {
        entity A { key ID: Integer; }
        entity B { key ID: Integer; }
      }
    `);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "INVALID_ANNOTATION_VALUE",
        target: "S",
        message: expect.stringContaining("@cds.query.limit must be"),
      }),
    ]);
  });

  test("max 0 is CAP's 'no limit', also over the service's", () => {
    expect(
      limits(`
        @mcp @cds.query.limit.max: 50 service S {
          @cds.query.limit.max: 0 entity A { key ID: Integer; }
        }
      `),
    ).toEqual({ "S.A": {} });
  });

  // CAP's own reading, from its paging handler: the reader must agree with it, or the tools
  // advertise limits CAP does not apply. A CAP release that changes the rules fails here. The
  // path is CAP-internal (no public API gives the page size): if a 10.x minor moves the file,
  // this test fails without the rules changing; find getPageSize again and update the path.
  const { getPageSize } = jest.requireActual<{
    getPageSize(def: unknown): { default: number; max: number };
  }>("@sap/cds/libx/_runtime/common/generic/paging.js");
  test.each([
    "@cds.query.limit: { default: 2, max: 3 } entity A { key ID: Integer; }",
    "@cds.query.limit: 10 entity A { key ID: Integer; }",
    "@cds.query.limit: { default: 50, max: 20 } entity A { key ID: Integer; }",
    "@cds.query.limit.max: 30 entity A { key ID: Integer; }",
    "entity A { key ID: Integer; }",
  ])("agrees with CAP's getPageSize (service default 20, max 50): %s", (entity) => {
    for (const service of ["", "@cds.query.limit: { default: 20, max: 50 }"]) {
      const csn = compileSnippet(`@mcp ${service} service S { ${entity} }`);
      const ours = onlyService(readModel(csn).spec).entities[0]?.limits;
      const cap = getPageSize((csn.definitions as Record<string, unknown>)["S.A"]);
      const max = ours?.maxRows ?? 1000; // CAP's global default max
      expect({ default: Math.min(ours?.defaultRows ?? max, max), max }).toEqual(cap);
    }
  });

  test("a value that is not a whole number is reported and ignored", () => {
    const { spec, diagnostics } = read(`
      @mcp service S { @cds.query.limit: { default: 'ten', max: 2.5 } entity A { key ID: Integer; } }
    `);
    expect(onlyService(spec).entities[0]?.limits).toBeUndefined();
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S.A" }),
      expect.objectContaining({ level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S.A" }),
    ]);
  });
});

describe("model-reader: @restrict grants", () => {
  test("grants are normalized as CAP does: one event each, WRITE expanded, to defaulting to any", () => {
    const csn = compileSnippet(`
      @restrict: [{ grant: '*', to: 'admin' }, { grant: 'READ', to: ['support', 'auditor'] }]
      @mcp service S {
        @restrict: [
          { grant: ['READ', 'WRITE'], to: 'admin' },
          { grant: 'READ', where: 'createdBy = $user' },
          { grant: 'cancel', to: 'support' }
        ]
        entity Orders { key ID: Integer; createdBy: String; } actions {
          @mcp @restrict: [{ to: 'support' }] action cancel();
        }
        @restrict: [{ grant: '*', to: 'admin' }] function audit() returns Integer;
      }
    `);
    const service = onlyService(readModel(csn).spec);
    // A service-level @restrict acts like @requires with all its roles (CAP's protocol check).
    expect(service.requires).toEqual(["admin", "support", "auditor"]);
    expect(service.entities[0]?.restrict).toEqual([
      { grant: "READ", to: ["admin"] },
      { grant: "CREATE", to: ["admin"] },
      { grant: "UPDATE", to: ["admin"] },
      { grant: "DELETE", to: ["admin"] },
      { grant: "READ", to: ["any"], where: true },
      { grant: "cancel", to: ["support"] },
    ]);
    // On an operation, a grant is always for the operation itself.
    expect(service.operations.map((o) => [o.name, o.restrict])).toEqual([
      ["S.Orders.cancel", [{ grant: "cancel", to: ["support"] }]],
      ["S.audit", [{ grant: "audit", to: ["admin"] }]],
    ]);
  });
});

describe("model-reader: return types", () => {
  test("operations carry their return type: scalar, entity, inline structure, or many of them", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; title: String; @mcp.omit costPrice: Decimal; }
        function count() returns Integer;
        function counts() returns array of Integer;
        function book() returns Books;
        function books() returns array of Books;
        function stock() returns { stock: Integer; };
        function nothing() returns Integer;
        @mcp action run();
      }
    `);
    const value = {
      name: "value",
      cdsType: "cds.Integer",
      key: false,
      mandatory: false,
      readonly: false,
      completion: false,
    };
    const plain = (name: string, cdsType: string, key = false) => ({
      name,
      cdsType,
      key,
      mandatory: false,
      readonly: false,
      completion: false,
    });
    const bookFields = [plain("ID", "cds.Integer", true), plain("title", "cds.String")];
    const returns = Object.fromEntries(
      onlyService(readModel(csn).spec).operations.map((o) => [o.name, o.returns]),
    );
    expect(returns).toEqual({
      "S.count": { many: false, scalar: value },
      "S.counts": { many: true, scalar: value },
      "S.book": { many: false, entity: "S.Books", fields: bookFields },
      "S.books": { many: true, entity: "S.Books", fields: bookFields },
      "S.stock": { many: false, fields: [plain("stock", "cds.Integer")] },
      "S.nothing": { many: false, scalar: value },
      "S.run": undefined,
    });
  });
});

describe("model-reader: operation parameters", () => {
  test("binding parameters are not offered; array parameters are many of their item type", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Orders { key ID: Integer; } actions {
          @mcp action tag(in: $self, @mandatory tags: array of String);
          @mcp action archiveAll(in: many $self);
        }
      }
    `);
    const [tag, archiveAll] = onlyService(readModel(csn).spec).operations;
    expect(tag?.params).toEqual([
      {
        name: "tags",
        cdsType: "cds.String",
        many: true,
        key: false,
        mandatory: true,
        readonly: false,
        completion: false,
      },
    ]);
    expect(archiveAll?.params).toEqual([]);
  });
});

describe("model-reader: draft return types", () => {
  test("an operation returning a draft entity leaves out CAP's draft columns", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @odata.draft.enabled entity Orders { key ID: UUID; status: String; }
        function latest() returns Orders;
      }
    `);
    const [latest] = onlyService(readModel(csn).spec).operations;
    expect(latest?.returns?.fields?.map((f) => f.name)).toEqual(["ID", "status"]);
  });
});

describe("model-reader: diagnostics", () => {
  const codes = (diagnostics: Diagnostic[]) =>
    diagnostics.map(({ level, code, target }) => ({ level, code, target }));

  test("an unknown @mcp.* key yields UNKNOWN_ANNOTATION naming the definition and key", () => {
    const csn = compileSnippet(`
      @mcp @mcp.descibe service S {
        entity Books { key ID: Integer; @mcp.hnit: 'x' title: String; }
        @mcp action order(@mcp.completon book: Integer);
      }
    `);
    const { diagnostics } = readModel(csn);
    expect(codes(diagnostics)).toEqual([
      { level: "warn", code: "UNKNOWN_ANNOTATION", target: "S" },
      { level: "warn", code: "UNKNOWN_ANNOTATION", target: "S.Books:title" },
      { level: "warn", code: "UNKNOWN_ANNOTATION", target: "S.order:book" },
    ]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("@mcp.descibe"),
      expect.stringContaining("@mcp.hnit"),
      expect.stringContaining("@mcp.completon"),
    ]);
  });

  test("an unknown key CAP copied to projections is reported once, where it was written, naming the copies", () => {
    const csn = compileSnippet(`
      namespace db;
      @mcp.descibe entity Books { key ID: Integer; @mcp.hnit title: String; }
      @mcp service A { entity Books as projection on db.Books; }
      service B { entity Books as projection on A.Books; }
    `);
    const { diagnostics } = readModel(csn);
    expect(diagnostics).toEqual([
      {
        level: "warn",
        code: "UNKNOWN_ANNOTATION",
        target: "db.Books",
        message:
          "Unknown annotation @mcp.descibe on db.Books; it has no effect (CAP copied it to db.A.Books, db.B.Books)",
      },
      {
        level: "warn",
        code: "UNKNOWN_ANNOTATION",
        target: "db.Books:title",
        message:
          "Unknown annotation @mcp.hnit on db.Books:title; it has no effect (CAP copied it to db.A.Books:title, db.B.Books:title)",
      },
    ]);
  });

  test("a key written again on a projection with a different value is its own diagnostic", () => {
    const csn = compileSnippet(`
      namespace db;
      @mcp.descibe: 'a' entity Books { key ID: Integer; }
      @mcp service A { @mcp.descibe: 'b' entity Books as projection on db.Books; }
    `);
    expect(codes(readModel(csn).diagnostics)).toEqual([
      { level: "warn", code: "UNKNOWN_ANNOTATION", target: "db.A.Books" },
      { level: "warn", code: "UNKNOWN_ANNOTATION", target: "db.Books" },
    ]);
  });

  test("v1-only annotations (@mcp.wrap.tools, @mcp.usePrimaryKey) yield V1_ANNOTATION", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.wrap.tools @mcp.usePrimaryKey @mcp.resource: ['filter', 'top']
        entity Books { key ID: Integer; }
        @mcp.tool action order();
      }
    `);
    // The shim's V1_DEFAULT_CHANGED checks are pinned in v1-shim.test.ts.
    const diagnostics = readModel(csn).diagnostics.filter((d) => d.code === "V1_ANNOTATION");
    expect(codes(diagnostics)).toEqual([
      { level: "warn", code: "V1_ANNOTATION", target: "S.Books" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.Books" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.Books" },
      { level: "warn", code: "V1_ANNOTATION", target: "S.order" },
    ]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("@mcp.wrap.tools"),
      expect.stringContaining("@mcp.usePrimaryKey"),
      expect.stringContaining("@mcp.resource"),
      expect.stringContaining("@mcp.tool"),
    ]);
    // v1's array form of @mcp.resource does not opt in to v2 resources.
    expect(onlyService(readModel(csn).spec).entities[0]?.resource).toBe(false);
  });

  test("a bound operation on an entity without keys yields BOUND_OPERATION_WITHOUT_KEYS", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Log { message: String; } actions { function latest() returns String; }
        entity Books { key ID: Integer; } actions { function price() returns Decimal; }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(codes(diagnostics)).toEqual([
      { level: "error", code: "BOUND_OPERATION_WITHOUT_KEYS", target: "S.Log.latest" },
    ]);
    // It could never address an instance, so it is not exposed.
    expect(onlyService(spec).operations.map((o) => o.name)).toEqual(["S.Books.price"]);
  });

  test("@mcp.omit on a key element of an exposed entity yields a warn-level diagnostic (get cannot address records)", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; @mcp.omit key edition: Integer; }
        entity Authors { key ID: Integer; }
      }
      service Hidden { entity Notes { @mcp.omit key ID: Integer; } }
    `);
    expect(codes(readModel(csn).diagnostics)).toEqual([
      { level: "warn", code: "OMITTED_KEY", target: "S.Books:edition" },
    ]);
  });

  test("entities whose records cannot be addressed offer only query (and create)", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.wrap.modes: ['create', 'update', 'delete']
        entity Log { message: String; }
        @mcp.wrap.modes: ['create', 'update', 'delete']
        entity Books { key ID: Integer; @mcp.omit key edition: Integer; title: String; }
          actions { function price() returns Decimal; }
        entity Secret { @mcp.omit key ID: Integer; name: String; }
          actions { function peek() returns String; }
        entity Plain { key ID: Integer; }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(exposed(spec).S).toEqual({
      entities: {
        "S.Log": ["create", "query"],
        "S.Books": ["create", "query"],
        "S.Secret": ["query"],
        "S.Plain": ["get", "query"],
      },
      operations: [],
    });
    expect(codes(diagnostics)).toEqual([
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S.Log" },
      { level: "warn", code: "OMITTED_KEY", target: "S.Books:edition" },
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S.Books" },
      { level: "error", code: "BOUND_OPERATION_WITHOUT_KEYS", target: "S.Books.price" },
      { level: "warn", code: "OMITTED_KEY", target: "S.Secret:ID" },
      { level: "error", code: "BOUND_OPERATION_WITHOUT_KEYS", target: "S.Secret.peek" },
    ]);
  });

  test("an element type with no JSON Schema mapping yields UNSUPPORTED_TYPE", () => {
    const csn = compileSnippet(`
      @mcp service S { entity Docs { key ID: Integer; embedding: Vector(3); title: String; } }
    `);
    expect(codes(readModel(csn).diagnostics)).toEqual([
      { level: "warn", code: "UNSUPPORTED_TYPE", target: "S.Docs:embedding" },
    ]);
  });

  test("a bound operation parameter named like a key of its entity yields PARAMETER_SHADOWS_KEY", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Orders { key ID: Integer; } actions {
          @mcp action cancel(ID: Integer not null);
          @mcp action close(reason: String);
        }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(codes(diagnostics)).toEqual([
      { level: "error", code: "PARAMETER_SHADOWS_KEY", target: "S.Orders.cancel:ID" },
    ]);
    expect(onlyService(spec).operations.map((o) => o.name)).toEqual(["S.Orders.close"]);
  });

  test("feature annotations on definitions that are never exposed yield UNUSED_ANNOTATION", () => {
    const csn = compileSnippet(`
      @mcp.describe @mcp.prompts: [{ name: 'p', template: 't' }]
      service S {
        @mcp.wrap.modes: ['create'] @mcp.resource entity Books { key ID: Integer; }
        @mcp.ui: 'ui://x/y.html' function card() returns Integer;
        @mcp.elicit: ['confirm'] action go();
      }
      @mcp service T {
        @mcp.name: 'Hidden' @mcp: false entity Hidden { key ID: Integer; }
        @mcp.elicit: ['confirm'] action stay();
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(spec.services.map((x) => x.name)).toEqual(["T"]);
    expect(codes(diagnostics)).toEqual([
      { level: "warn", code: "UNUSED_ANNOTATION", target: "S" },
      { level: "warn", code: "UNUSED_ANNOTATION", target: "S.Books" },
      { level: "warn", code: "UNUSED_ANNOTATION", target: "S.card" },
      { level: "warn", code: "UNUSED_ANNOTATION", target: "S.go" },
      { level: "warn", code: "UNUSED_ANNOTATION", target: "T.stay" },
    ]);
    expect(diagnostics[1]?.message).toContain("@mcp.wrap.modes");
  });

  test("an @mcp.prompts entry without name or template, or with an unknown role, is a diagnostic", () => {
    const csn = compileSnippet(`
      @mcp @mcp.prompts: [
        { name: 'ok', template: 'Hi' },
        { template: 'no name' },
        { name: 'no-template' },
        { name: 'bad-role', template: 'x', role: 'system' }
      ]
      service S {}
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(onlyService(spec).prompts.map((p) => p.name)).toEqual(["ok"]);
    expect(codes(diagnostics)).toEqual([
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S" },
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S" },
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S" },
    ]);
  });

  test("@mcp.elicit values other than 'confirm' and parameter names are diagnosed; it still confirms", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp @mcp.elicit: ['confirm', 'amout'] action pay(amount: Integer);
        @mcp @mcp.elicit: 'confirm' action go();
        @mcp @mcp.elicit action flag();
        @mcp @mcp.elicit: [] action none();
        @mcp @mcp.elicit: [1] action odd();
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    // Anything that asks for confirmation keeps asking: a typo must never switch it off.
    expect(onlyService(spec).operations.map((o) => [o.name, o.elicit])).toEqual([
      ["S.pay", ["confirm", "amout"]],
      ["S.go", ["confirm"]],
      ["S.flag", ["confirm"]],
      ["S.none", ["confirm"]],
      ["S.odd", ["confirm"]],
    ]);
    expect(diagnostics.filter((d) => d.code === "INVALID_ANNOTATION_VALUE")).toEqual([
      {
        level: "error",
        code: "INVALID_ANNOTATION_VALUE",
        target: "S.pay",
        message:
          "@mcp.elicit value amout is neither 'confirm' nor a parameter of S.pay; the call is still confirmed",
      },
      expect.objectContaining({ target: "S.go" }),
      expect.objectContaining({ target: "S.none" }),
      expect.objectContaining({ target: "S.odd" }),
    ]);
  });

  test("@mcp.deepInsert on anything but a composition is INVALID_ANNOTATION_VALUE", () => {
    const csn = compileSnippet(`
      @mcp service S {
        entity Books { key ID: Integer; @mcp.deepInsert author: Association to Authors; }
        entity Authors { key ID: Integer; }
      }
    `);
    expect(codes(readModel(csn).diagnostics)).toEqual([
      { level: "error", code: "INVALID_ANNOTATION_VALUE", target: "S.Books:author" },
    ]);
  });

  test("write modes on a draft's child yield DRAFT_WRITE_NOT_SUPPORTED and are not offered", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @odata.draft.enabled entity Orders {
          key ID: UUID;
          items: Composition of many Items on items.up_ = $self;
        }
        @mcp.wrap.modes: ['create', 'update'] entity Items { key ID: UUID; up_: Association to Orders; }
      }
    `);
    const { spec, diagnostics } = readModel(csn);
    expect(exposed(spec).S?.entities["S.Items"]).toEqual(["get", "query"]);
    expect(codes(diagnostics)).toEqual([
      { level: "error", code: "DRAFT_WRITE_NOT_SUPPORTED", target: "S.Items" },
    ]);
  });

  test("the demo model reads with zero error-level diagnostics", async () => {
    const { diagnostics } = readModel(await compileDemo());
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });
});

describe("model-reader: grouping copied diagnostics (M6 review)", () => {
  test("a key written on a CAP-generated entity is reported on the projections that copy it", () => {
    const csn = compileSnippet(`
      entity Books { key ID: Integer; title: localized String; }
      annotate Books.texts with @mcp.foo;
      annotate Books.texts with { title @mcp.bar };
      @mcp service S { entity T as projection on Books.texts; }
    `);
    const unknown = readModel(csn)
      .diagnostics.filter((d) => d.code === "UNKNOWN_ANNOTATION")
      .map((d) => d.target);
    expect(unknown).toEqual(["S.T", "S.T:title"]);
  });
});
