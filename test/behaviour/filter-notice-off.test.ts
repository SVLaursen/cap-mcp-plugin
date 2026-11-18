import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { callTool, rpc, type Caller } from "../helpers/mcp";

/** ADR 0015: with cds.mcp.filterNotices false, nothing is added for anyone. */
const demo = bootDemo();
const env = cds.env as unknown as { mcp?: Record<string, unknown> };
env.mcp = { ...env.mcp, filterNotices: false };

const LINE = "Your access to these records is limited by authorization.";
const result = async (who: Caller, name: string, args: Record<string, unknown>) =>
  (await callTool(demo.POST, who, name, args)).message?.result as {
    structuredContent?: Record<string, unknown>;
  };

test.each(["alice", "bob", "carol"] as const)(
  "%s's tools carry no line and no notice",
  async (who) => {
    const tools = (await rpc(demo.POST, who, "tools/list")).message?.result?.tools as {
      description: string;
      outputSchema?: { properties?: Record<string, unknown> };
    }[];
    expect(tools.some((t) => t.description.includes(LINE))).toBe(false);
    expect(tools.some((t) => t.outputSchema?.properties?.notice)).toBe(false);
  },
);

test("filtered reads come back as before: no notice, plain not found", async () => {
  expect(await result("bob", "OrdersService_Orders_query", { select: ["orderNo"] })).toMatchObject({
    structuredContent: { rows: [{ orderNo: "ORD-1001" }], total: 1 },
  });
  expect(
    (await result("carol", "OrdersService_Returns_query", {})).structuredContent,
  ).not.toHaveProperty("notice");
  const ID = "00000000-0000-4000-8000-000000000000";
  expect((await result("bob", "OrdersService_Orders_get", { ID })).structuredContent).toEqual({
    error: { code: "NOT_FOUND", message: `No OrdersService.Orders with {"ID":"${ID}"}` },
  });
});
