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
  test.todo(
    "@mcp.wrap.modes adds the listed write modes to query/get; unknown modes are diagnostics",
  );
  test.todo("@mcp.resource marks the entity as resource; no other annotation does");
  test.todo("@mcp.prompts on a service produces PromptSpecs; prompts are not created otherwise");
  test.todo("@mcp.ui on an operation sets ui to the ui:// URI; a non-ui:// value is a diagnostic");
  test.todo("@mcp.elicit on an operation sets elicit");
  test.todo("@mcp.completion on an element or parameter sets completion: true");
  test.todo("@mcp.describe on a service sets describe: true; default is false");
  test.todo("@mcp.compact on a service sets compact: true; default is false");
  test.todo("@mcp.deepInsert on a composition element lists it in deepInsert");
  test.todo("draft-enabled entities have draft: true");
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
