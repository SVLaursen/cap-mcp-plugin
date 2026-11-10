/**
 * M1 — model-reader: CSN + @mcp annotations → ExposureSpec.
 * Spec: docs/annotations.md. Turn each todo into a real test (red), then implement (green).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readModel } from "../../src/model-reader";
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

describe("model-reader: opt-in", () => {
  test.todo("a model without any @mcp annotation produces an empty spec and no diagnostics");
  test.todo("@mcp on a service exposes every entity with modes {query, get} and nothing else");
  test.todo("@mcp on a service exposes every function (bound and unbound)");
  test.todo("@mcp on a service does NOT expose actions without their own @mcp");
  test.todo("@mcp on an action exposes it even when the service has no @mcp");
  test.todo("@mcp on a single entity exposes only that entity, with modes {query, get}");
  test.todo("@mcp: false on an entity removes it from an @mcp service");
  test.todo("@cds.api.ignore on an entity or element removes it");
  test.todo("@mcp.omit elements never appear in fields or keys");
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
  test.todo("the demo model reads with zero error-level diagnostics");
});
