/**
 * M3 — executor writes, through the CAP service so custom handlers run. Own file, so writes
 * never change what the read tests see (cds.test gives each file its own database).
 */
import { as, bootDemo } from "../helpers/demo";
import { callTool, expectInvalidArgument } from "../helpers/tools";

const demo = bootDemo();

const error = (code: string, extra: Record<string, unknown> = {}) => ({
  error: expect.objectContaining({ code, ...extra }),
});

describe("executor: writes", () => {
  test("create on AdminService.Books inserts through the service; custom before-handlers run", async () => {
    const created = await callTool("alice", "AdminService_create", {
      entity: "AdminService.Books",
      data: { ID: 910, title: "Villette", author_ID: 107, price: "9.99", stock: 3 },
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toEqual(
      expect.objectContaining({ ID: 910, title: "Villette", price: "9.99", stock: 3 }),
    );
    expect(created.structuredContent).not.toHaveProperty("costPrice");
    const odata = await demo.GET("/admin/Books(910)?$select=title", as("alice"));
    expect(odata.data.title).toBe("Villette");
    // CAP's own input checks apply too (author is @mandatory).
    const missing = await callTool("alice", "AdminService_create", {
      entity: "AdminService.Books",
      data: { ID: 911, title: "No author" },
    });
    expect(missing.structuredContent).toEqual(error("ASSERT_MANDATORY", { target: "author_ID" }));
  });

  test("several input errors at once come back as one tool error with every target", async () => {
    const result = await callTool("alice", "AdminService_create", {
      entity: "AdminService.Books",
      data: { ID: 930, title: "Too much", stock: 5000 },
    });
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: string; details: { target?: string; code: string }[] };
      }
    ).error;
    expect(error.code).toBe("MULTIPLE_ERRORS");
    expect(error.details.map((d) => d.target).sort()).toEqual(["author_ID", "stock"]);
    expect(error.details.every((d) => typeof d.code === "string" && d.code.length > 0)).toBe(true);
  });

  test("create on an entity without keys returns what was written, not some other record", async () => {
    const args = { message: "mine", rating: 5 };
    const result = await callTool("bob", "CatalogService_Feedback_create", args);
    expect(result.structuredContent).toEqual({ message: "mine", rating: 5 });
    // The agent's arguments are not changed by the call.
    expect(args).toEqual({ message: "mine", rating: 5 });
  });

  test("a negative price is rejected by the demo handler with code PRICE_NEGATIVE, target price", async () => {
    const result = await callTool("alice", "AdminService_update", {
      entity: "AdminService.Books",
      key: { ID: 201 },
      data: { price: -1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(error("PRICE_NEGATIVE", { target: "price" }));
  });

  test("update changes only provided fields; readonly fields are refused by schema", async () => {
    const updated = await callTool("alice", "AdminService_update", {
      entity: "AdminService.Books",
      key: { ID: 201 },
      data: { stock: 42 },
    });
    expect(updated.structuredContent).toEqual(
      expect.objectContaining({ ID: 201, stock: 42, title: "Wuthering Heights" }),
    );
    for (const data of [
      { createdAt: "2020-01-01T00:00:00Z" },
      { costPrice: "1.00" },
      { ID: 202 },
    ]) {
      const result = await callTool("alice", "AdminService_update", {
        entity: "AdminService.Books",
        key: { ID: 201 },
        data,
      });
      expect(result.structuredContent).toEqual(error("INVALID_ARGUMENT"));
    }
    const missing = await callTool("alice", "AdminService_update", {
      entity: "AdminService.Books",
      key: { ID: 999 },
      data: { stock: 1 },
    });
    expect(missing.structuredContent).toEqual(error("NOT_FOUND"));
  });

  test("delete removes the row", async () => {
    const deleted = await callTool("alice", "AdminService_delete", {
      entity: "AdminService.Books",
      key: { ID: 252 },
    });
    expect(deleted.isError).toBeFalsy();
    expect((await demo.GET("/admin/Books(252)", as("alice"))).status).toBe(404);
    const again = await callTool("alice", "AdminService_delete", {
      entity: "AdminService.Books",
      key: { ID: 252 },
    });
    expect(again.structuredContent).toEqual(error("NOT_FOUND"));
  });

  test("a write tool for an entity without that mode is not listed and not callable", async () => {
    await expect(callTool("bob", "CatalogService_Books_create")).rejects.toThrow(
      /-32602 Tool \w+ not found/,
    );
    // Authors in AdminService has no write modes: the compact write tools refuse it.
    const result = await callTool("alice", "AdminService_create", {
      entity: "AdminService.Authors",
      data: { ID: 500, name: "Anne Brontë" },
    });
    // Not in the tool's entity enum, so the SDK's input-schema check refuses it.
    expectInvalidArgument(result);
  });
});
