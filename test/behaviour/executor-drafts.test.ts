/**
 * M3 — writes to draft-enabled entities go through CAP's draft API, in the caller's one
 * transaction: create is NEW → SAVE, update is EDIT → patch → SAVE, so the app's draft handlers
 * see what they see over OData. A failure anywhere rolls back, leaving no draft.
 */
import cds from "@sap/cds";
import { as, bootDemo } from "../helpers/demo";
import { callTool, expectInvalidArgument, page } from "../helpers/tools";

const demo = bootDemo();

const ORDER = "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a01"; // ORD-1001, bob's

/** Every draft of Orders, whoever owns it (OData only shows a user their own drafts). */
async function drafts() {
  return (await cds.db.run({
    SELECT: { from: { ref: ["OrdersService.Orders.drafts"] }, columns: [{ ref: ["ID"] }] },
  } as never)) as unknown[];
}

describe("executor: drafts and deep insert", () => {
  test("create on draft-enabled Orders goes NEW → (patch) → SAVE and yields an active order", async () => {
    const result = await callTool("bob", "OrdersService_Orders_create", { reason: "gift" });
    expect(result.isError).toBeFalsy();
    const order = result.structuredContent as Record<string, unknown>;
    // The app's SAVE handler ran (it numbers orders), and the order is active, not a draft.
    expect(order).toEqual(expect.objectContaining({ reason: "gift", status: "open" }));
    expect(order.orderNo).toMatch(/^ORD-/);
    expect(order).not.toHaveProperty("IsActiveEntity");
    expect(await drafts()).toEqual([]);
  });

  test("deep insert of Orders with items creates the composition children", async () => {
    const result = await callTool("bob", "OrdersService_Orders_create", {
      reason: "with items",
      items: [
        { book_ID: 251, quantity: 3 },
        { book_ID: 252, quantity: 1 },
      ],
    });
    const { ID } = result.structuredContent as { ID: string };
    const items = page(
      await callTool("bob", "OrdersService_OrderItems_query", {
        where: [{ field: "up__ID", op: "eq", value: ID }],
        select: ["book_ID", "quantity"],
        orderby: [{ field: "book_ID" }],
      }),
    );
    expect(items.rows).toEqual([
      { book_ID: 251, quantity: 3 },
      { book_ID: 252, quantity: 1 },
    ]);
    // Children are checked against their own fields; the back link is CAP's to fill.
    for (const items of [
      [{ book_ID: 251, nope: 1 }],
      [{ book_ID: 251, up__ID: ORDER }],
      { book_ID: 251 },
    ]) {
      const bad = await callTool("bob", "OrdersService_Orders_create", { reason: "bad", items });
      expectInvalidArgument(bad);
    }
  });

  test("update on draft-enabled Orders goes EDIT → patch → SAVE and leaves no draft", async () => {
    const result = await callTool("bob", "OrdersService_Orders_update", {
      ID: ORDER,
      reason: "updated",
    });
    expect(result.isError).toBeFalsy();
    // SAVE handlers see the whole order, as with OData's draftActivate: the number stays.
    expect(result.structuredContent).toEqual(
      expect.objectContaining({ ID: ORDER, reason: "updated", orderNo: "ORD-1001" }),
    );
    const odata = await demo.GET(
      `/orders/Orders(ID=${ORDER},IsActiveEntity=true)?$select=reason`,
      as("bob"),
    );
    expect(odata.data.reason).toBe("updated");
    expect(await drafts()).toEqual([]);
  });

  test("draft activation handlers run: the demo's SAVE validation rejects a long reason", async () => {
    const result = await callTool("bob", "OrdersService_Orders_update", {
      ID: ORDER,
      reason: "x".repeat(201),
    });
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "REASON_TOO_LONG", target: "reason" }),
    });
    const created = await callTool("bob", "OrdersService_Orders_create", {
      reason: "y".repeat(201),
    });
    expect(created.structuredContent).toEqual({
      error: expect.objectContaining({ code: "REASON_TOO_LONG" }),
    });
    expect(await drafts()).toEqual([]);
  });

  test("an update while someone holds a draft of the order is refused, not merged", async () => {
    const edit = await demo.POST(
      `/orders/Orders(ID=${ORDER},IsActiveEntity=true)/OrdersService.draftEdit`,
      { PreserveChanges: true },
      as("bob"),
    );
    expect(edit.status).toBe(201);
    const result = await callTool("bob", "OrdersService_Orders_update", {
      ID: ORDER,
      reason: "racing",
    });
    expect(result.structuredContent).toEqual({
      error: expect.objectContaining({ code: "DRAFT_ALREADY_EXISTS" }),
    });
    await demo.DELETE(`/orders/Orders(ID=${ORDER},IsActiveEntity=false)`, as("bob"));
  });

  test("delete on a draft root removes the active order", async () => {
    const created = await callTool("bob", "OrdersService_Orders_create", { reason: "to delete" });
    const { ID } = created.structuredContent as { ID: string };
    const deleted = await callTool("bob", "OrdersService_Orders_delete", { ID });
    expect(deleted.structuredContent).toEqual({ deleted: { ID } });
    const odata = await demo.GET(`/orders/Orders(ID=${ID},IsActiveEntity=true)`, as("bob"));
    expect(odata.status).toBe(404);
    expect(await drafts()).toEqual([]);
  });

  test("a draft write CAP refuses is a tool error and leaves no draft behind", async () => {
    // Carol can read every order (support) but may only write her own (@restrict where).
    const result = await callTool("carol", "OrdersService_Orders_update", {
      ID: ORDER,
      reason: "not mine",
    });
    expect(result.isError).toBe(true);
    expect(await drafts()).toEqual([]);
  });
});
