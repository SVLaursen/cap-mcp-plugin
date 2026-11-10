import { as, bootDemo } from "../helpers/demo";

/**
 * Baseline: the demo app and CAP's own behaviour, with no MCP involved.
 *
 * These pass today and must keep passing. They pin down what CAP already enforces, so the MCP
 * tests later can assert "same result over MCP as over OData" instead of re-deriving rules.
 */
const demo = bootDemo();

describe("demo baseline (OData)", () => {
  test("boots and serves the catalog", async () => {
    const { status, data } = await demo.GET("/browse/Books?$select=ID,title", as("bob"));
    expect(status).toBe(200);
    expect(data.value).toHaveLength(5);
  });

  test("CAP enforces @requires on AdminService", async () => {
    expect((await demo.GET("/admin/Books", as("bob"))).status).toBe(403);
    expect((await demo.GET("/admin/Books", as("alice"))).status).toBe(200);
  });

  test("CAP enforces @restrict where: bob sees only his own orders, support sees all", async () => {
    const bob = await demo.GET("/orders/Orders?$select=orderNo", as("bob"));
    const carol = await demo.GET("/orders/Orders?$select=orderNo", as("carol"));
    expect(bob.data.value.map((o: { orderNo: string }) => o.orderNo)).toEqual(["ORD-1001"]);
    expect(carol.data.value).toHaveLength(2);
  });

  test("CAP errors carry code and target", async () => {
    const { status, data } = await demo.POST(
      "/browse/submitOrder",
      { book: 201, quantity: 5000 },
      as("bob"),
    );
    expect(status).toBe(409);
    expect(data.error).toMatchObject({ message: "ORDER_EXCEEDS_STOCK", target: "quantity" });
  });

  test("custom handlers validate writes (negative price is rejected)", async () => {
    const { status, data } = await demo.PATCH("/admin/Books(201)", { price: -1 }, as("alice"));
    expect(status).toBe(400);
    expect(data.error).toMatchObject({ message: "PRICE_NEGATIVE", target: "price" });
  });

  test("deleting book 207 fails at commit time and leaves the row in place", async () => {
    const del = await demo.DELETE("/admin/Books(207)", as("alice"));
    expect(del.status).toBeGreaterThanOrEqual(500);
    const after = await demo.GET("/admin/Books(207)?$select=ID", as("alice"));
    expect(after.status).toBe(200);
  });
});
