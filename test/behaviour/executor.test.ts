/**
 * M3 — executor, exercised end to end over /mcp against the demo app (cds.test).
 * Every call goes through srv.run / srv.send in the request's cds.context.
 */
import { bootDemo } from "../helpers/demo";
import { callTool as call, page } from "../helpers/tools";

bootDemo();

describe("executor: reads", () => {
  test("query returns { rows, total, nextCursor } and rows never contain costPrice", async () => {
    const result = await call("bob", "CatalogService_Books_query", {
      top: 2,
      orderby: [{ field: "ID" }],
    });
    expect(result.isError).toBeFalsy();
    const { rows, total, nextCursor } = page(result);
    expect(total).toBe(5);
    expect(rows.map((r) => r.ID)).toEqual([201, 207]);
    expect(typeof nextCursor).toBe("string");
    expect(rows.every((r) => !("costPrice" in r))).toBe(true);
    expect(Object.keys(rows[0] ?? {})).toContain("price");
  });

  test("query paging: following nextCursor returns the next page; the last page has none", async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = page(await call("bob", "CatalogService_Books_query", { top: 2, cursor }));
      seen.push(...result.rows.map((r) => r.ID));
      cursor = result.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    // Stable order by key when no orderby is given, so pages neither overlap nor skip.
    expect(seen).toEqual([201, 207, 251, 252, 271]);
  });

  test("query count ignores top/skip/orderby (v1 bug: count with skip > 0 returned nothing)", async () => {
    const first = page(await call("bob", "CatalogService_Books_query", { top: 2 }));
    const second = page(
      await call("bob", "CatalogService_Books_query", {
        top: 2,
        cursor: first.nextCursor,
        orderby: [{ field: "title", dir: "desc" }],
      }),
    );
    expect(second.total).toBe(5);
    expect(second.rows).toHaveLength(2);
  });

  test("query where/orderby/select use only exposed scalar fields; omitted fields are rejected", async () => {
    const ok = page(
      await call("bob", "CatalogService_Books_query", {
        where: [{ field: "stock", op: "gt", value: 100 }],
        orderby: [{ field: "stock", dir: "desc" }],
        select: ["ID", "stock"],
      }),
    );
    expect(ok.rows).toEqual([
      { ID: 252, stock: 555 },
      { ID: 251, stock: 333 },
    ]);
    for (const args of [
      { where: [{ field: "costPrice", op: "gt", value: 0 }] },
      { orderby: [{ field: "costPrice" }] },
      { select: ["costPrice"] },
      { select: ["nope"] },
    ]) {
      const result = await call("bob", "CatalogService_Books_query", args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      });
    }
  });

  test("where values are checked against the field's type before CQN is built ('in' needs an array, 'contains' a string field)", async () => {
    const inList = page(
      await call("bob", "CatalogService_Books_query", {
        where: [{ field: "ID", op: "in", value: [201, 252] }],
      }),
    );
    expect(inList.rows.map((r) => r.ID)).toEqual([201, 252]);
    const contains = page(
      await call("bob", "CatalogService_Books_query", {
        where: [{ field: "title", op: "contains", value: "Rav" }],
      }),
    );
    expect(contains.rows.map((r) => r.ID)).toEqual([251]);
    for (const where of [
      [{ field: "ID", op: "in", value: 201 }],
      [{ field: "stock", op: "contains", value: "1" }],
      [{ field: "stock", op: "gt", value: "lots" }],
      [{ field: "title", op: "like", value: "x" }],
    ]) {
      const result = await call("bob", "CatalogService_Books_query", { where });
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      });
    }
  });

  test("q search goes through SELECT.search and @cds.search, never over omitted fields", async () => {
    // @cds.search on CatalogService.Books lists title, descr and authorName.
    const poe = page(await call("bob", "CatalogService_Books_query", { q: "Poe" }));
    expect(poe.rows.map((r) => r.ID).sort()).toEqual([251, 252]);
    // Authors has no @cds.search: CAP would search every String, including the omitted email.
    const byEmail = page(await call("bob", "CatalogService_Authors_query", { q: "example" }));
    expect(byEmail.rows).toEqual([]);
    const byName = page(await call("bob", "CatalogService_Authors_query", { q: "Brontë" }));
    expect(byName.total).toBe(2);
  });

  test("get returns one record; a missing key is a NOT_FOUND tool error, not null", async () => {
    const found = await call("bob", "CatalogService_Books_get", { ID: 201 });
    expect(found.structuredContent).toEqual(
      expect.objectContaining({ ID: 201, title: "Wuthering Heights" }),
    );
    expect(found.structuredContent).not.toHaveProperty("costPrice");
    const missing = await call("bob", "CatalogService_Books_get", { ID: 999 });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({
      error: expect.objectContaining({ code: "NOT_FOUND" }),
    });
  });

  test("compact tools: entity and fields are checked against the target's own schema; omitted or unknown fields are rejected", async () => {
    // AdminService is @mcp.compact in the demo.
    const ok = page(
      await call("alice", "AdminService_query", {
        entity: "AdminService.Books",
        where: [{ field: "ID", op: "eq", value: 201 }],
        select: ["ID", "title"],
      }),
    );
    expect(ok.rows).toEqual([{ ID: 201, title: "Wuthering Heights" }]);
    const got = await call("alice", "AdminService_get", {
      entity: "AdminService.Books",
      key: { ID: 207 },
    });
    expect(got.structuredContent).toEqual(expect.objectContaining({ ID: 207 }));
    for (const args of [
      { entity: "AdminService.AuditNotes" }, // @mcp: false
      { entity: "CatalogService.Books" }, // another service
      { entity: "AdminService.Books", where: [{ field: "costPrice", op: "gt", value: 0 }] },
      { entity: "AdminService.Books", select: ["costPrice"] },
    ]) {
      const result = await call("alice", "AdminService_query", args);
      expect(result.structuredContent).toEqual({
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      });
    }
    const badKey = await call("alice", "AdminService_get", {
      entity: "AdminService.Books",
      key: { ID: 201, costPrice: 1 },
    });
    expect(badKey.structuredContent).toEqual({
      error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    });
  });

  test("results are structuredContent plus ONE text block (not one block per row)", async () => {
    const result = await call("bob", "CatalogService_Books_query", {});
    expect(typeof result.text).toBe("string");
    expect(JSON.parse(result.text)).toEqual(result.structuredContent);
  });

  test("@mcp.resource entities: results carry resource_link items to cap://<Service>/<Entity>/<key>", async () => {
    const result = await call("alice", "AdminService_query", {
      entity: "AdminService.Authors",
      top: 2,
    });
    expect(result.links).toEqual([
      { uri: "cap://AdminService/Authors/101", name: "AdminService.Authors 101" },
      { uri: "cap://AdminService/Authors/107", name: "AdminService.Authors 107" },
    ]);
    const books = await call("bob", "CatalogService_Books_query", { top: 1 });
    expect(books.links).toBeUndefined();
  });
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
