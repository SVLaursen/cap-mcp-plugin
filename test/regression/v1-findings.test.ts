/**
 * One test per correctness/security issue found in v1 (docs/v1-reference.md).
 * Each must be written red against the v2 code path FIRST, then made green.
 */
import { as, bootDemo, withEnv } from "../helpers/demo";
import { listTools } from "../helpers/mcp";
import { callTool, page } from "../helpers/tools";

const demo = bootDemo();

describe("v1 regressions", () => {
  test("#1 a failed commit is reported as an error (AdminService DELETE Books 207 fails at commit)", async () => {
    // The executor never commits or catches: the service's transaction does, and its failure
    // reaches the agent as a tool error (the message is hidden in production, as CAP does).
    const result = await callTool("alice", "AdminService_delete", {
      entity: "AdminService.Books",
      key: { ID: 207 },
    });
    expect(result).toEqual({ text: "SIMULATED_COMMIT_FAILURE", isError: true });
    // In production (as CAP decides it: NODE_ENV or CDS_ENV), the message stays on the server.
    const envs: Record<string, string>[] = [
      { NODE_ENV: "production" },
      { NODE_ENV: "test", CDS_ENV: "prod" },
    ];
    for (const env of envs) {
      const hidden = await withEnv(env, () =>
        callTool("alice", "AdminService_delete", {
          entity: "AdminService.Books",
          key: { ID: 207 },
        }),
      );
      expect(hidden).toEqual({ text: "Internal error", isError: true });
    }
    expect((await demo.GET("/admin/Books(207)?$select=ID", as("alice"))).status).toBe(200);
  });
  test("#2 q search never matches on @mcp.omit fields (an omitted email is not searchable)", async () => {
    // CAP's own search covers every String of Authors, including the omitted email...
    // ($count: CAP pages Authors at 2, @cds.query.limit in the demo.)
    const odata = await demo.GET(
      "/browse/Authors?$search=example.com&$count=true&$top=1",
      as("bob"),
    );
    expect(odata.data["@odata.count"]).toBe(4);
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
    // Nor does anything else /mcp publishes to bob (tool names, schemas, descriptions).
    const listed = JSON.stringify((await listTools(demo.POST, "bob")).message?.result);
    for (const hidden of [
      "AdminService",
      "sap.capire",
      "AuditNotes",
      "costPrice",
      "email",
      "restock",
    ]) {
      expect(listed).not.toContain(hidden);
    }
  });
  test("#4 there is no session state: a request never sees tools resolved for another user", async () => {
    // v1 kept one server per session and reused its tool list. Interleave alice and bob on the
    // same endpoint, sending whatever session id a stateful server might have handed out.
    const names = async (who: "alice" | "bob", headers: Record<string, string> = {}) => {
      const res = await listTools(demo.POST, who, { headers });
      expect(res.headers["mcp-session-id"]).toBeUndefined();
      return (res.message?.result?.tools as { name: string }[]).map((t) => t.name);
    };
    const alice = await names("alice");
    expect(alice).toContain("AdminService_query");
    for (const headers of [{}, { "mcp-session-id": "alice-session" }] as Record<string, string>[]) {
      expect(await names("bob", headers)).not.toContain("AdminService_query");
      expect(await names("alice", headers)).toEqual(alice);
    }
    await expect(
      callTool("bob", "AdminService_query", { entity: "AdminService.Books" }),
    ).rejects.toThrow(/-32602 Tool AdminService_query not found/);
  });
  test("#5 reads and writes run with the same user context (cds.context.user)", async () => {
    // Reads: @restrict where createdBy = $user only lets bob see his own order.
    const orders = page(
      await callTool("bob", "OrdersService_Orders_query", { select: ["orderNo"] }),
    );
    expect(orders.rows).toEqual([{ orderNo: "ORD-1001" }]);
    // Writes: CAP stamps the managed createdBy/modifiedBy with the caller, not a technical user.
    await callTool("alice", "AdminService_create", {
      entity: "AdminService.Books",
      data: { ID: 920, title: "Agnes Grey", author_ID: 101 },
    });
    await callTool("alice", "AdminService_update", {
      entity: "AdminService.Books",
      key: { ID: 920 },
      data: { stock: 1 },
    });
    const book = await demo.GET("/admin/Books(920)?$select=createdBy,modifiedBy", as("alice"));
    expect(book.data).toMatchObject({ createdBy: "alice", modifiedBy: "alice" });
  });
  test("#6 count with skip > 0 returns the full count", async () => {
    const first = page(await callTool("bob", "CatalogService_Books_query", { top: 2 }));
    const third = page(
      await callTool("bob", "CatalogService_Books_query", { top: 2, cursor: first.nextCursor }),
    );
    // Same count as OData, whatever earlier tests in this file wrote.
    const odata = await demo.GET("/browse/Books/$count", as("bob"));
    expect(third.total).toBe(Number(odata.data));
    expect(third.rows).toHaveLength(2);
  });
});
