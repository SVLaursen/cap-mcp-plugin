/**
 * M3 — executor, exercised end to end over /mcp against the demo app (cds.test).
 * Every call goes through srv.run / srv.send in the request's cds.context.
 */
describe("executor: reads", () => {
  test.todo("query returns { rows, total, nextCursor } and rows never contain costPrice");
  test.todo("query paging: following nextCursor returns the next page; the last page has none");
  test.todo("query count ignores top/skip/orderby (v1 bug: count with skip > 0 returned nothing)");
  test.todo(
    "query where/orderby/select use only exposed scalar fields; omitted fields are rejected",
  );
  test.todo(
    "where values are checked against the field's type before CQN is built ('in' needs an array, 'contains' a string field)",
  );
  test.todo(
    "compact tools: entity, fields in where/orderby/select/key/data and operation args are checked against the target's own schema; omitted or unknown fields are rejected",
  );
  test.todo("q search goes through SELECT.search and @cds.search, never over omitted fields");
  test.todo("get returns one record; a missing key is a NOT_FOUND tool error, not null");
  test.todo("results are structuredContent plus ONE text block (not one block per row)");
  test.todo(
    "@mcp.resource entities: results carry resource_link items to cap://<Service>/<Entity>/<key>",
  );
});

describe("executor: writes", () => {
  test.todo("create on AdminService.Books inserts through the service; custom before-handlers run");
  test.todo(
    "a negative price is rejected by the demo handler with code PRICE_NEGATIVE, target price",
  );
  test.todo("update changes only provided fields; readonly fields are refused by schema");
  test.todo("delete removes the row");
  test.todo("a write tool for an entity without that mode is not listed and not callable");
});

describe("executor: operations", () => {
  test.todo("unbound function stockByGenre returns its value as structured content");
  test.todo("unbound action submitOrder runs the handler and returns { stock }");
  test.todo(
    "submitOrder over stock returns a tool error with code ORDER_EXCEEDS_STOCK and target quantity",
  );
  test.todo("the unannotated action restock is neither listed nor callable");
  test.todo("bound action OrdersService.Orders.cancel takes the order key plus parameters");
});

describe("executor: drafts and deep insert", () => {
  test.todo("create on draft-enabled Orders goes NEW → (patch) → SAVE and yields an active order");
  test.todo("update on draft-enabled Orders goes EDIT → patch → SAVE");
  test.todo("deep insert of Orders with items creates the composition children");
});

describe("executor: authorization is CAP's", () => {
  test.todo("bob's Orders query over MCP returns exactly what OData returns for bob");
  test.todo("bob calling an AdminService tool gets a 403-equivalent tool error from CAP");
});
