/**
 * M3 — operations through srv.send, so the app's handlers run and their errors reach the agent.
 */
import { as, bootDemo } from "../helpers/demo";
import { callTool, executeDirectly, expectInvalidArgument } from "../helpers/tools";

const demo = bootDemo();

const ORDER = "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a01"; // ORD-1001, bob's

describe("executor: operations", () => {
  test("unbound function stockByGenre returns its value as structured content", async () => {
    const result = await callTool("bob", "CatalogService_stockByGenre", { genre: 11 });
    expect(result.structuredContent).toEqual({ value: 23 });
  });

  test("unbound action submitOrder runs the handler and returns { stock }", async () => {
    const result = await callTool("bob", "CatalogService_submitOrder", { book: 201, quantity: 2 });
    expect(result.structuredContent).toEqual({ value: { stock: 10 } });
  });

  test("submitOrder over stock returns a tool error with code ORDER_EXCEEDS_STOCK and target quantity", async () => {
    const result = await callTool("bob", "CatalogService_submitOrder", {
      book: 201,
      quantity: 5000,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "ORDER_EXCEEDS_STOCK", target: "quantity" }),
    });
  });

  test("CAP error messages are translated as over OData, in the caller's language", async () => {
    const seen: string[] = [];
    // undefined: no Accept-Language at all, so CAP's default locale applies.
    for (const language of ["en", "de", undefined]) {
      const headers: Record<string, string> = language ? { "accept-language": language } : {};
      const odataOrder = await demo.POST(
        "/browse/submitOrder",
        { book: 201, quantity: 5000 },
        { ...as("bob"), headers },
      );
      const mcpOrder = await callTool(
        "bob",
        "CatalogService_submitOrder",
        { book: 201, quantity: 5000 },
        { headers },
      );
      expect(mcpOrder.structuredContent).toEqual({
        error: expect.objectContaining({
          code: "ORDER_EXCEEDS_STOCK",
          message: odataOrder.data.error.message,
        }),
      });
      seen.push(odataOrder.data.error.message);
      // CAP's own messages too (author is @mandatory).
      const data = { ID: 940, title: "No author" };
      const odataBook = await demo.POST("/admin/Books", data, { ...as("alice"), headers });
      const mcpBook = await callTool(
        "alice",
        "AdminService_create",
        { entity: "AdminService.Books", data },
        { headers },
      );
      expect(mcpBook.structuredContent).toEqual({
        error: expect.objectContaining({
          code: "ASSERT_MANDATORY",
          message: odataBook.data.error.message,
        }),
      });
      seen.push(odataBook.data.error.message);
    }
    // The two languages really differ, so the check above is not vacuous.
    expect(new Set(seen).size).toBe(4);
  });

  test("an app's own 404 keeps its code; CAP's bare 404 becomes NOT_FOUND", async () => {
    const result = await callTool("bob", "CatalogService_bookCard", { book: 999 });
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "BOOK_NOT_FOUND", target: "book" }),
    });
  });

  test("records an operation returns never carry @mcp.omit fields", async () => {
    const result = await callTool("bob", "CatalogService_bookCard", { book: 201 });
    const value = (result.structuredContent as { value: Record<string, unknown> }).value;
    expect(value).toEqual(expect.objectContaining({ ID: 201, title: "Wuthering Heights" }));
    expect(value).not.toHaveProperty("costPrice");
  });

  test("operation arguments are checked: unknown and mistyped parameters are refused", async () => {
    for (const args of [{ genre: 11, extra: 1 }, { genre: "eleven" }]) {
      const result = await callTool("bob", "CatalogService_stockByGenre", args);
      expectInvalidArgument(result);
    }
  });

  test("the unannotated action restock is neither listed nor callable", async () => {
    await expect(
      callTool("bob", "CatalogService_restock", { book: 201, quantity: 1 }),
    ).rejects.toThrow(/-32602 Tool \w+ not found/);
  });

  test("an @mcp.elicit operation does not run until the call is confirmed", async () => {
    const unconfirmed = await callTool("bob", "OrdersService_Orders_cancel", {
      ID: ORDER,
      reason: "changed my mind",
    });
    expect(unconfirmed.structuredContent).toEqual({
      error: expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }),
    });
    const order = await callTool("bob", "OrdersService_Orders_get", { ID: ORDER });
    expect(order.structuredContent).toEqual(expect.objectContaining({ status: "submitted" }));
  });

  test("bound action OrdersService.Orders.cancel takes the order key plus parameters", async () => {
    // Confirmed directly; the MRTR round trip over /mcp is in opt-in-features.test.ts.
    const result = await executeDirectly(
      "bob",
      "OrdersService_Orders_cancel",
      { ID: ORDER, reason: "changed my mind" },
      { confirmed: true },
    );
    expect(result.isError).toBeFalsy();
    const value = (result.structuredContent as { value: Record<string, unknown> }).value;
    expect(value).toEqual(
      expect.objectContaining({ ID: ORDER, status: "cancelled", reason: "changed my mind" }),
    );
    // A returned record carries no draft bookkeeping.
    expect(value).not.toHaveProperty("IsActiveEntity");
    expect(value).not.toHaveProperty("HasDraftEntity");
  });
});
