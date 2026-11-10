/**
 * One test per correctness/security issue found in v1 (docs/v1-reference.md).
 * Each must be written red against the v2 code path FIRST, then made green.
 */
import { as, bootDemo } from "../helpers/demo";
import { callTool, page } from "../helpers/tools";

const demo = bootDemo();

describe("v1 regressions", () => {
  test.todo(
    "#1 a failed commit is reported as an error (AdminService DELETE Books 207 fails at commit)",
  );
  test("#2 q search never matches on @mcp.omit fields (an omitted email is not searchable)", async () => {
    // CAP's own search covers every String of Authors, including the omitted email...
    const odata = await demo.GET("/browse/Authors?$search=example.com&$select=ID", as("bob"));
    expect(odata.data.value).toHaveLength(4);
    // ...so q must not, or the agent could probe hidden values.
    const mcp = page(await callTool("bob", "CatalogService_Authors_query", { q: "example.com" }));
    expect(mcp).toEqual({ rows: [], total: 0 });
  });
  test("#3 the describe tool never reveals unexposed entities, db-layer entities or omitted fields", async () => {
    const result = await callTool("bob", "CatalogService_describe");
    const text = JSON.stringify(result.structuredContent);
    for (const hidden of [
      "AdminService",
      "OrdersService",
      "sap.capire",
      "AuditNotes",
      "costPrice",
      "email",
      "restock",
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(text).toContain("CatalogService.Books");
  });
  test.todo("#4 there is no session state: a request never sees tools resolved for another user");
  test.todo("#5 reads and writes run with the same user context (cds.context.user)");
  test("#6 count with skip > 0 returns the full count", async () => {
    const first = page(await callTool("bob", "CatalogService_Books_query", { top: 2 }));
    const third = page(
      await callTool("bob", "CatalogService_Books_query", { top: 2, cursor: first.nextCursor }),
    );
    expect(third.total).toBe(5);
  });
});
