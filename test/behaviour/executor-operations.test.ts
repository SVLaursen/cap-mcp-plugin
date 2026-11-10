/**
 * M3 — operations through srv.send, so the app's handlers run and their errors reach the agent.
 */
import { bootDemo } from "../helpers/demo";
import { callTool } from "../helpers/tools";

bootDemo();

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

  test("an app's own 404 keeps its code; CAP's bare 404 becomes NOT_FOUND", async () => {
    const result = await callTool("bob", "CatalogService_bookCard", { book: 999 });
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "BOOK_NOT_FOUND", target: "book" }),
    });
  });

  test("operation arguments are checked: unknown and mistyped parameters are refused", async () => {
    for (const args of [{ genre: 11, extra: 1 }, { genre: "eleven" }]) {
      const result = await callTool("bob", "CatalogService_stockByGenre", args);
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      });
    }
  });

  test("the unannotated action restock is neither listed nor callable", async () => {
    await expect(
      callTool("bob", "CatalogService_restock", { book: 201, quantity: 1 }),
    ).rejects.toThrow(/not listed/);
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
    const result = await callTool(
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
