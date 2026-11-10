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
      ["S.Orders", [{ element: "items", target: "S.Items" }]],
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
    expect(entities.map((e) => [e.name, e.draft])).toEqual([
      ["S.Orders", true],
      ["S.Items", true],
      ["S.Books", false],
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

  test("v1-only annotations (@mcp.wrap.tools, @mcp.usePrimaryKey) yield V1_ANNOTATION", () => {
    const csn = compileSnippet(`
      @mcp service S {
        @mcp.wrap.tools @mcp.usePrimaryKey @mcp.resource: ['filter', 'top']
        entity Books { key ID: Integer; }
        @mcp.tool action order();
      }
    `);
    const { diagnostics } = readModel(csn);
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

  test("the demo model reads with zero error-level diagnostics", async () => {
    const { diagnostics } = readModel(await compileDemo());
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });
});
