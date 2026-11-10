/**
 * M5 — opt-in features, each against its demo target (see demo/README.md).
 */
describe("opt-in: baseline", () => {
  test.todo(
    "CatalogService exposes query+get for Books, Authors, Genres and both functions — and nothing else",
  );
  test.todo("AdminService.AuditNotes (@mcp: false) is absent for every user, including alice");
  test.todo("AdminService.Genres.parent (@cds.api.ignore) is absent from schemas and results");
});

describe("opt-in: describe and compact", () => {
  test.todo("CatalogService_describe lists only CatalogService's exposed entities and fields");
  test.todo("the describe tool never mentions costPrice, email, AuditNotes or db-layer entities");
  test.todo("AdminService (compact) exposes the generic tool set, scoped to its entities");
});

describe("opt-in: resources", () => {
  test.todo("cap://AdminService/Authors/101 reads one author without email");
  test.todo("resources/list does not enumerate whole tables");
  test.todo("CatalogService entities (no @mcp.resource) have no resources");
});

describe("opt-in: prompts", () => {
  test.todo("AdminService's restock-plan prompt is listed for alice and hidden from bob");
  test.todo("prompt arguments are validated and substituted");
});

describe("opt-in: MCP Apps (issue #133)", () => {
  test.todo("bookCard is registered as an app tool linked to ui://bookshop/book-card.html");
  test.todo("the ui resource serves demo/app/mcp-apps/book-card.html with the MCP App mime type");
  test.todo("a hook lets the app supply its own resource registration");
});

describe("opt-in: confirmation (MRTR)", () => {
  test.todo("calling cancel returns resultType input_required with a confirmation request");
  test.todo("retrying with a declining inputResponse leaves the order unchanged");
  test.todo("retrying with an accepting inputResponse cancels the order");
});

describe("opt-in: completion", () => {
  test.todo("completion/complete for submitOrder.book returns matching book IDs");
  test.todo("parameters without @mcp.completion return no completions");
});
