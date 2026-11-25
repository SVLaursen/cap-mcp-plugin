import { readFileSync } from "node:fs";
import path from "node:path";
import { bootDemo } from "../helpers/demo";
import { callTool, legacyRpc, rpc, type Caller } from "../helpers/mcp";

/**
 * ADR 0015 on the demo: tell the agent when CAP filters its reads, only then.
 * - OrdersService.Orders: bob and alice read through `where createdBy = $user` only (filtered);
 *   carol also has an unconditional support grant (not filtered).
 * - OrdersService.Returns: carol reads through a `where` (filtered), alice unconditionally, bob
 *   not at all (no tools).
 * - CatalogService.Books: no restriction.
 * fixtures/unfiltered-baseline.json was captured at 83e6d69, the commit before this change.
 */
const demo = bootDemo();

const baseline = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "unfiltered-baseline.json"), "utf8"),
) as Record<"carol" | "bob", Record<string, unknown>>;

const BOBS = "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a01";
const CAROLS = "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a02";
const NOWHERE = "00000000-0000-4000-8000-000000000000";
const LINE = "Your access to these records is limited by authorization.";
const notice = (entity: string) =>
  `Your authorization limits which ${entity} records you can see. Records outside it are not ` +
  "included in this result. An empty or smaller result does not mean that no other records exist.";

type Result = { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown };
const call = async (who: Caller, name: string, args: Record<string, unknown> = {}) =>
  (await callTool(demo.POST, who, name, args)).message?.result as Result;
const tools = async (who: Caller) =>
  (await rpc(demo.POST, who, "tools/list")).message?.result?.tools as {
    name: string;
    description: string;
    outputSchema?: { properties?: Record<string, unknown> };
  }[];
const textOf = (result: Result) => (result.content as { text: string }[])[0]?.text;
/**
 * Timestamps are set when the demo boots, so they differ from the captured run; `_meta` names
 * the server and its package version, which a release changes.
 */
const stable = (value: unknown) => {
  const { _meta: _server, ...rest } = value as Record<string, unknown>;
  return JSON.stringify(rest).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "…");
};

describe("a filtered user", () => {
  test.each([
    ["with rows", {}, [{ orderNo: "ORD-1001" }]],
    ["empty", { where: [{ field: "orderNo", op: "eq", value: "ORD-1002" }] }, []],
  ])(
    "gets the notice on query results, %s, in structured and text content",
    async (_w, args, rows) => {
      const result = await call("bob", "OrdersService_Orders_query", {
        select: ["orderNo"],
        ...args,
      });
      expect(result.structuredContent).toEqual({
        notice: notice("OrdersService.Orders"),
        rows,
        total: rows.length,
      });
      expect(textOf(result)).toContain(notice("OrdersService.Orders"));
    },
  );

  test("gets 'not found, or not visible' from get, for a missing and for a hidden record", async () => {
    for (const ID of [NOWHERE, CAROLS]) {
      const result = await call("bob", "OrdersService_Orders_get", { ID });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "NOT_FOUND",
          message: `No OrdersService.Orders with {"ID":"${ID}"}, or it is not visible to you: your authorization limits which OrdersService.Orders records you can see.`,
        },
      });
    }
  });

  test("gets no notice on a record it found", async () => {
    const result = await call("bob", "OrdersService_Orders_get", { ID: BOBS });
    expect(result.structuredContent).toMatchObject({ ID: BOBS, orderNo: "ORD-1001" });
    expect(result.structuredContent).not.toHaveProperty("notice");
  });

  test("sees one more line on the entity's query and get tools, and no other tool changes", async () => {
    const listed = await tools("bob");
    expect(listed.filter((t) => t.description.includes(LINE)).map((t) => t.name)).toEqual([
      "OrdersService_Orders_get",
      "OrdersService_Orders_query",
    ]);
    const query = listed.find((t) => t.name === "OrdersService_Orders_query");
    expect(query?.description.endsWith(`\n\n${LINE}`)).toBe(true);
    expect(query?.outputSchema?.properties?.notice).toEqual({ type: "string" });
  });

  test("the same holds on another entity, for another user (carol on Returns)", async () => {
    const result = await call("carol", "OrdersService_Returns_query", { select: ["reason"] });
    expect(result.structuredContent).toEqual({
      notice: notice("OrdersService.Returns"),
      rows: [{ reason: "Damaged cover" }],
      total: 1,
    });
  });

  test("the notice names no condition, attribute, user, value or count", async () => {
    const result = await call("bob", "OrdersService_Orders_query", {});
    const text = String(result.structuredContent?.notice);
    for (const part of ["createdBy", "$user", "bob", "where", "support", "1", "2"]) {
      expect(text).not.toContain(part);
    }
  });
});

describe("an unfiltered user or entity", () => {
  test("a user without any grant still has no tool for the entity", async () => {
    expect((await tools("bob")).some((t) => t.name.startsWith("OrdersService_Returns_"))).toBe(
      false,
    );
  });

  test("an unconditional grant (alice on Returns) gives no notice", async () => {
    const result = await call("alice", "OrdersService_Returns_query", { select: ["reason"] });
    expect(result.structuredContent).toEqual({
      rows: [{ reason: "Damaged cover" }, { reason: "Wrong edition" }],
      total: 2,
    });
    const listed = await tools("alice");
    expect(listed.filter((t) => t.description.includes(LINE)).map((t) => t.name)).toEqual([
      "OrdersService_Orders_get",
      "OrdersService_Orders_query",
    ]);
  });

  test.each([
    ["tools/list", "tools", () => rpc(demo.POST, "carol", "tools/list")],
    ["tools/list (2025-era)", "legacyTools", () => legacyRpc(demo.POST, "carol", "tools/list")],
  ])(
    "both a conditional and an unconditional grant (carol on Orders): %s is as at 83e6d69, apart from the new Returns tools",
    async (_what, key, list) => {
      const result = (await list()).message?.result as { tools: { name: string }[] };
      const before = (baseline.carol[key] as { tools: { name: string }[] }).tools;
      expect(
        JSON.stringify(result.tools.filter((t) => !t.name.startsWith("OrdersService_Returns_"))),
      ).toBe(JSON.stringify(before));
    },
  );

  test.each([
    [
      "carol",
      "ordersQuery",
      "OrdersService_Orders_query",
      { orderby: [{ field: "orderNo" }], select: ["orderNo", "status"] },
    ],
    [
      "carol",
      "ordersQueryEmpty",
      "OrdersService_Orders_query",
      { where: [{ field: "orderNo", op: "eq", value: "ORD-9999" }], select: ["orderNo"] },
    ],
    ["carol", "ordersGet", "OrdersService_Orders_get", { ID: BOBS }],
    ["carol", "ordersGetMissing", "OrdersService_Orders_get", { ID: NOWHERE }],
    ["carol", "booksQuery", "CatalogService_Books_query", { top: 3, select: ["ID", "title"] }],
    ["bob", "booksGet", "CatalogService_Books_get", { ID: 201 }],
    ["bob", "booksGetMissing", "CatalogService_Books_get", { ID: 999 }],
    [
      "bob",
      "booksQueryEmpty",
      "CatalogService_Books_query",
      { where: [{ field: "ID", op: "eq", value: 999 }] },
    ],
  ] as const)("%s's %s is as at 83e6d69", async (who, key, name, args) => {
    const result = await call(who, name, args);
    expect(stable(result)).toBe(stable(baseline[who][key]));
  });
});
