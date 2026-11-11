import { readConfig } from "../../src/config";
import { ExposureRegistry } from "../../src/exposure-registry";
import type { UserLike } from "../../src/types";
import { compileSnippet } from "../helpers/snippet";

/**
 * M6 — characterisation: the annotation forms of v1's own demo app (gavdilabs/cap-mcp-plugin
 * 1.8, test/demo) and its config, read by v2 through the shim. The expected lists are what v1
 * served for that app, renamed where v2 names differ; docs/v1-compatibility.md is the
 * human-readable checklist and must match these tests.
 */
const V1_DEMO = `
  context my.bookshop {
  entity Books { key ID: Integer @mcp.hint: 'Unique'; title: String; stock: Integer;
    secretMessage: String @mcp.omit; author: Association to Authors; }
  entity Authors { key ID: Integer; name: String @mcp.hint: 'Full name';
    books: Association to many Books on books.author = $self; }
  entity MultiKeyExample { key ID: Integer; key ExternalKey: Integer; description: String; }
  }

  service CatalogService {
    @mcp: { name: 'books', description: 'Book data list', resource: ['filter', 'orderby', 'select', 'skip', 'top'] }
    entity Books as projection on my.bookshop.Books actions {
      @mcp: { name: 'get-stock', description: 'Retrieves stock', tool: true }
      function getStock() returns Integer;
    };
    @mcp: { name: 'authors', description: 'Author data list', resource: true }
    entity Authors as projection on my.bookshop.Authors;
    @restrict: [{ grant: ['READ'], to: ['read-role'] }, { grant: ['*'], to: ['admin'] }]
    entity MultiKeyExamples as projection on my.bookshop.MultiKeyExample actions {
      @mcp: { name: 'get-multi-key', description: 'Gets multi key entity', tool: true }
      function getMultiKey() returns String;
    };
    @mcp: { name: 'get-author', description: 'Gets the desired author', tool: true, elicit: ['input'] }
    @requires: 'book-keeper'
    function getAuthor(id: String) returns String;
    @requires: 'author-specialist'
    @mcp: { name: 'get-author-details', description: 'Gets author details', tool: true }
    function getAuthorDetails() returns String;
    @mcp: { name: 'books-by-author', description: 'Books by author', tool: true, elicit: ['input', 'confirm'] }
    function getBooksByAuthor(authorName: String @mcp.hint: 'Full name') returns array of String;
    @mcp: { name: 'book-recommendation', description: 'A random book', tool: true }
    function getBookRecommendation() returns String;
  }
  annotate CatalogService.Books with @mcp.wrap: {
    tools: true, modes: ['query', 'get', 'create', 'update', 'delete'], hint: 'Read and write'
  };
  annotate CatalogService.Authors with @mcp.wrap: {
    tools: true, modes: ['query', 'get', 'create', 'update'],
    hint: { query: 'Lists', get: 'One', create: 'New author', update: 'Change author' }
  };
  annotate CatalogService with @mcp.prompts: [{
    name: 'give-me-book-abstract', title: 'Book Abstract', description: 'Abstract of a book',
    template: 'Give me an abstract of the book {{book-id}}', role: 'user',
    inputs: [{ key: 'book-id', type: 'String' }]
  }];

  service AdminService {
    @mcp: { name: 'admin-books', description: 'Book data list', resource: ['filter', 'orderby', 'select', 'skip', 'top'] }
    entity Books as projection on my.bookshop.Books actions {
      @mcp: { name: 'get-stock-as-admin', description: 'Retrieves stock', tool: true }
      function getStock() returns Integer;
    };
    @mcp: { name: 'book-recommendation-admin-service', description: 'A random book', tool: true }
    function getBookRecommendation() returns String;
  }
`;

/** v1's demo config (test/demo/package.json, cds.mcp). */
const V1_CONFIG = {
  name: "mock-service",
  version: "0.0.1",
  auth: "none",
  instructions: { file: "mcp-instructions.md" },
  wrap_entities_to_actions: true,
  wrap_entity_modes: ["query", "get"],
};

const everyone: UserLike = { id: "everyone", is: () => true };
const { config, v1, diagnostics: configDiagnostics } = readConfig(V1_CONFIG);
const registry = ExposureRegistry.fromModel(compileSnippet(V1_DEMO), { v1 });

describe("v1 compatibility: v1's demo app under v2", () => {
  test("entity tools keep their v1 names (Service_Entity_mode) and modes", () => {
    const entityTools = registry
      .toolsFor(everyone)
      .filter((t) => t.target.kind === "entity")
      .map((t) => t.name);
    expect(entityTools).toEqual([
      "AdminService_Books_get",
      "AdminService_Books_query",
      "CatalogService_Authors_create",
      "CatalogService_Authors_get",
      "CatalogService_Authors_query",
      "CatalogService_Authors_update",
      "CatalogService_Books_create",
      "CatalogService_Books_delete",
      "CatalogService_Books_get",
      "CatalogService_Books_query",
      "CatalogService_Books_update",
    ]);
  });

  test("operation tools are named <Service>_<operation> instead of their v1 @mcp.name", () => {
    const operations = registry
      .toolsFor(everyone)
      .filter((t) => t.target.kind === "operation")
      .map((t) => [t.name, t.title]);
    expect(operations).toEqual([
      ["AdminService_Books_getStock", "get-stock-as-admin"],
      ["AdminService_getBookRecommendation", "book-recommendation-admin-service"],
      ["CatalogService_Books_getStock", "get-stock"],
      ["CatalogService_MultiKeyExamples_getMultiKey", "get-multi-key"],
      ["CatalogService_getAuthor", "get-author"],
      ["CatalogService_getAuthorDetails", "get-author-details"],
      ["CatalogService_getBookRecommendation", "book-recommendation"],
      ["CatalogService_getBooksByAuthor", "books-by-author"],
    ]);
  });

  test("elicitation asks for the same inputs; descriptions and hints carry over", () => {
    const ops = registry.spec.services.flatMap((s) => s.operations);
    expect(ops.find((o) => o.name === "CatalogService.getAuthor")?.elicit).toEqual(["id"]);
    expect(ops.find((o) => o.name === "CatalogService.getBooksByAuthor")?.elicit).toEqual([
      "authorName",
      "confirm",
    ]);
    const books = registry.spec.services
      .flatMap((s) => s.entities)
      .find((e) => e.name === "CatalogService.Books");
    expect(books?.description).toBe("Book data list");
    expect(books?.fields.map((f) => [f.name, f.description])).toEqual([
      ["ID", "Unique"],
      ["title", undefined],
      ["stock", undefined],
      ["author_ID", undefined],
    ]);
  });

  test("the prompt is unchanged; resources become v2's (Authors by key); describe is opt-in now", () => {
    expect(registry.promptsFor(everyone).map((p) => p.name)).toEqual(["give-me-book-abstract"]);
    expect(registry.resourcesFor(everyone).map((r) => r.uriTemplate)).toEqual([
      "cap://CatalogService/Authors/{key}",
    ]);
    expect(registry.toolsFor(everyone).some((t) => t.target.kind === "describe")).toBe(false);
  });

  test("config: name, version and instructions carry over; the rest is reported", () => {
    expect(config).toEqual({
      name: "mock-service",
      version: "0.0.1",
      instructions: { file: "mcp-instructions.md" },
    });
    expect(configDiagnostics.map((d) => d.target)).toEqual([
      "cds.mcp.auth",
      "cds.mcp.wrap_entities_to_actions",
      "cds.mcp.wrap_entity_modes",
    ]);
  });

  test("every change from v1 is in the startup diagnostics", () => {
    const v1Diagnostics = registry.diagnostics
      .filter((d) => d.code.startsWith("V1_"))
      .map((d) => `${d.code} ${d.target}`);
    expect(v1Diagnostics).toEqual([
      ...Array(3).fill("V1_ANNOTATION CatalogService.Books"), // resource list, wrap.tools, wrap.hint
      "V1_ANNOTATION CatalogService.Books.getStock",
      ...Array(5).fill("V1_ANNOTATION CatalogService.Authors"), // wrap.tools, 4 × wrap.hint.<mode>
      "V1_ANNOTATION CatalogService.MultiKeyExamples.getMultiKey",
      "V1_ANNOTATION CatalogService.getAuthor",
      "V1_ANNOTATION CatalogService.getAuthorDetails",
      "V1_ANNOTATION CatalogService.getBooksByAuthor",
      "V1_ANNOTATION CatalogService.getBookRecommendation",
      "V1_ANNOTATION AdminService.Books",
      "V1_ANNOTATION AdminService.Books.getStock",
      "V1_ANNOTATION AdminService.getBookRecommendation",
      "V1_ANNOTATION CatalogService.getAuthor", // elicit 'input'
      "V1_ANNOTATION CatalogService.getBooksByAuthor", // elicit 'input'
      "V1_DEFAULT_CHANGED cds.mcp.enable_model_description",
    ]);
    // Nothing else: no unknown keys, no errors.
    expect(registry.diagnostics.filter((d) => !d.code.startsWith("V1_"))).toEqual([]);
  });
});
