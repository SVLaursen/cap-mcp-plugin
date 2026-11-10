/**
 * M1 — model-reader: CSN + @mcp annotations → ExposureSpec.
 * Spec: docs/annotations.md. Turn each todo into a real test (red), then implement (green).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readModel } from "../../src/model-reader";
import type { ExposureSpec, FieldSpec, ServiceSpec } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";

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

  test("@mcp.deepInsert on a composition element lists it in deepInsert", () => {
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
      ["S.Orders", ["items"]],
      ["S.Items", []],
      ["S.Notes", []],
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
  test.todo(
    "description falls back: @mcp.description → @description → doc comment → @title → none",
  );
  test.todo("title falls back: @mcp.name → @title → definition name");
  test.todo("element descriptions use @mcp.hint → @description → doc comment");
});

describe("model-reader: field shapes", () => {
  test.todo("keys are FieldSpecs with key: true, in declaration order");
  test.todo("@mandatory and not null set mandatory: true");
  test.todo("@readonly, @Core.Computed and managed fields set readonly: true");
  test.todo("enum types list their values; length, precision, scale and @assert.range are carried");
  test.todo("managed associations appear as their foreign key fields with target set");
  test.todo("operation parameters typed as Entity:element resolve to the element's builtin type");
});

describe("model-reader: diagnostics", () => {
  test.todo("an unknown @mcp.* key yields UNKNOWN_ANNOTATION naming the definition and key");
  test.todo("v1-only annotations (@mcp.wrap.tools, @mcp.usePrimaryKey) yield V1_ANNOTATION");
  test.todo("a bound operation on an entity without keys yields BOUND_OPERATION_WITHOUT_KEYS");
  test.todo(
    "@mcp.omit on a key element of an exposed entity yields a warn-level diagnostic (get cannot address records)",
  );
  test.todo("the demo model reads with zero error-level diagnostics");
});
