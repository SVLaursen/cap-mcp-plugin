import { readFileSync } from "node:fs";
import path from "node:path";
import { DEMO_DIR, bootDemo, type DemoUser } from "../helpers/demo";
import { listTools, rpc, type Caller } from "../helpers/mcp";
import { callTool, expectInvalidArgument, page } from "../helpers/tools";

/**
 * M5 — opt-in features, each against its demo target (see demo/README.md).
 */
const demo = bootDemo();

describe("opt-in: baseline", () => {
  const names = async (who: DemoUser) => {
    const res = await listTools(demo.POST, who);
    return (res.message?.result?.tools as { name: string }[]).map((t) => t.name);
  };

  test("CatalogService exposes query+get for Books, Authors, Genres and both functions — and nothing else", async () => {
    const catalog = (await names("bob")).filter((n) => n.startsWith("CatalogService_"));
    expect(catalog).toEqual([
      "CatalogService_Authors_get",
      "CatalogService_Authors_query",
      "CatalogService_Books_get",
      "CatalogService_Books_query",
      // Feedback has no key: query (baseline) and create (@mcp.wrap.modes) only.
      "CatalogService_Feedback_create",
      "CatalogService_Feedback_query",
      "CatalogService_Genres_get",
      "CatalogService_Genres_query",
      "CatalogService_bookCard",
      // @mcp.describe
      "CatalogService_describe",
      "CatalogService_stockByGenre",
      // @mcp on the action; restock (no @mcp) is absent.
      "CatalogService_submitOrder",
    ]);
  });

  test("AdminService.AuditNotes (@mcp: false) is absent for every user, including alice", async () => {
    for (const who of ["alice", "bob", "carol"] as const) {
      expect((await names(who)).filter((n) => /AuditNotes/.test(n))).toEqual([]);
    }
    const listed = await callTool("alice", "AdminService_list_entities");
    expect(JSON.stringify(listed.structuredContent)).not.toMatch(/AuditNotes/);
    const res = await rpc(demo.POST, "alice", "tools/list");
    expect(JSON.stringify(res.message?.result)).not.toMatch(/AuditNotes/);
    // Named anyway: refused before CAP is asked.
    for (const tool of ["AdminService_query", "AdminService_describe_entity"]) {
      expectInvalidArgument(await callTool("alice", tool, { entity: "AdminService.AuditNotes" }));
    }
  });

  test("AdminService.Genres.parent (@cds.api.ignore) is absent from schemas and results", async () => {
    const described = await callTool("alice", "AdminService_describe_entity", {
      entity: "AdminService.Genres",
    });
    const rows = page(
      await callTool("alice", "AdminService_query", { entity: "AdminService.Genres" }),
    );
    const genre = await callTool("alice", "AdminService_get", {
      entity: "AdminService.Genres",
      key: { ID: 10 },
    });
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const seen of [described.structuredContent, rows, genre.structuredContent]) {
      expect(JSON.stringify(seen)).not.toMatch(/parent/);
    }
    expectInvalidArgument(
      await callTool("alice", "AdminService_query", {
        entity: "AdminService.Genres",
        select: ["parent_ID"],
      }),
    );
  });
});

describe("opt-in: describe and compact", () => {
  type Described = {
    entities: { name: string; fields: { name: string }[] }[];
    operations: { name: string }[];
  };

  test("CatalogService_describe lists only CatalogService's exposed entities and fields", async () => {
    const described = (await callTool("bob", "CatalogService_describe"))
      .structuredContent as Described;
    expect(described.entities.map((e) => e.name)).toEqual([
      "CatalogService.Books",
      "CatalogService.Authors",
      "CatalogService.Genres",
      "CatalogService.Feedback",
    ]);
    expect(described.operations.map((o) => o.name)).toEqual([
      "CatalogService.stockByGenre",
      "CatalogService.bookCard",
      "CatalogService.submitOrder",
    ]);
    const authors = described.entities.find((e) => e.name === "CatalogService.Authors");
    expect(authors?.fields.map((f) => f.name)).toEqual([
      "createdAt",
      "createdBy",
      "modifiedAt",
      "modifiedBy",
      "ID",
      "name",
      "dateOfBirth",
      "placeOfBirth",
    ]);
  });

  test("the describe tool never mentions costPrice, email, AuditNotes or db-layer entities", async () => {
    for (const who of ["alice", "bob"] as const) {
      const whole = await callTool(who, "CatalogService_describe");
      const books = await callTool(who, "CatalogService_describe", {
        entity: "CatalogService.Books",
      });
      for (const result of [whole, books]) {
        expect(result.isError).toBeUndefined();
        expect(result.text).not.toMatch(
          /costPrice|email|AuditNotes|sap\.capire|AdminService|OrdersService/,
        );
      }
    }
  });

  test("AdminService (compact) exposes the generic tool set, scoped to its entities", async () => {
    const res = await listTools(demo.POST, "alice");
    const tools = (res.message?.result?.tools as { name: string; inputSchema: Schema }[]).filter(
      (t) => t.name.startsWith("AdminService_"),
    );
    // No per-entity tools; no call_operation (AdminService has no operations).
    expect(tools.map((t) => t.name)).toEqual([
      "AdminService_create",
      "AdminService_delete",
      "AdminService_describe_entity",
      "AdminService_get",
      "AdminService_list_entities",
      "AdminService_query",
      "AdminService_update",
    ]);
    const all = ["AdminService.Books", "AdminService.Authors", "AdminService.Genres"];
    const enumOf = (name: string) =>
      tools.find((t) => t.name === name)?.inputSchema.properties?.entity?.enum;
    for (const name of ["AdminService_describe_entity", "AdminService_get", "AdminService_query"]) {
      expect(enumOf(name)).toEqual(all);
    }
    // Writes only where @mcp.wrap.modes allows them.
    for (const name of ["AdminService_create", "AdminService_update", "AdminService_delete"]) {
      expect(enumOf(name)).toEqual(["AdminService.Books"]);
    }
    // A write to an entity without the mode is refused before CAP is asked.
    expectInvalidArgument(
      await callTool("alice", "AdminService_delete", {
        entity: "AdminService.Authors",
        key: { ID: 101 },
      }),
    );
    // The compact set works end to end.
    const book = await callTool("alice", "AdminService_get", {
      entity: "AdminService.Books",
      key: { ID: 201 },
    });
    expect(book.structuredContent).toMatchObject({ ID: 201 });
    expect(book.structuredContent).not.toHaveProperty("costPrice");
  });
});

type Schema = { properties?: Record<string, { enum?: string[] }> };

describe("opt-in: resources", () => {
  const read = (who: Caller, uri: string) => rpc(demo.POST, who, "resources/read", { uri });

  test("cap://AdminService/Authors/101 reads one author without email", async () => {
    const res = await read("alice", "cap://AdminService/Authors/101");
    const contents = res.message?.result?.contents as {
      uri: string;
      mimeType: string;
      text: string;
    }[];
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      uri: "cap://AdminService/Authors/101",
      mimeType: "application/json",
    });
    const author = JSON.parse(contents[0]?.text ?? "{}") as Record<string, unknown>;
    expect(author).toMatchObject({ ID: 101, name: "Emily Brontë" });
    expect(author).not.toHaveProperty("email");
    // The record a tool links to is the one the resource serves.
    const got = await callTool("alice", "AdminService_get", {
      entity: "AdminService.Authors",
      key: { ID: 101 },
    });
    expect(got.links).toEqual([
      { uri: "cap://AdminService/Authors/101", name: expect.any(String) },
    ]);
    expect(author).toEqual(got.structuredContent);
  });

  test("a missing or malformed key is a resource-not-found error", async () => {
    // 2026-07-28: resources/read misses are Invalid Params with the uri (no more -32002).
    for (const uri of ["cap://AdminService/Authors/999", "cap://AdminService/Authors/abc"]) {
      const res = await read("alice", uri);
      expect(res.message?.error).toMatchObject({ code: -32602, data: { uri } });
    }
  });

  test("resources/list does not enumerate whole tables", async () => {
    const list = await rpc(demo.POST, "alice", "resources/list");
    // Only MCP App UIs (ui://) are listed; never cap:// records.
    const listed = list.message?.result?.resources as { uri: string }[];
    expect(listed.filter((r) => !r.uri.startsWith("ui://"))).toEqual([]);
    const templates = await rpc(demo.POST, "alice", "resources/templates/list");
    expect(templates.message?.result?.resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "cap://AdminService/Authors/{key}",
        name: "AdminService_Authors",
        mimeType: "application/json",
      }),
    ]);
  });

  test("CatalogService entities (no @mcp.resource) have no resources", async () => {
    const uri = "cap://CatalogService/Authors/101";
    const res = await read("alice", uri);
    expect(res.message?.error).toMatchObject({ code: -32602, data: { uri } });
    const got = await callTool("bob", "CatalogService_Authors_get", { ID: 101 });
    expect(got.links).toBeUndefined();
    // Bob cannot reach AdminService: no templates, and its resource is not found for him.
    // (He still has resources: the MCP App UIs of his CatalogService tools.)
    const templates = await rpc(demo.POST, "bob", "resources/templates/list");
    expect(templates.message?.result?.resourceTemplates).toEqual([]);
    expect((await read("bob", "cap://AdminService/Authors/101")).message?.error).toBeDefined();
  });

  test("resources are advertised to those who can read them, without listChanged", async () => {
    const discover = await rpc(demo.POST, "alice", "server/discover");
    expect(discover.message?.result?.capabilities).toMatchObject({
      resources: { listChanged: false },
    });
  });
});

describe("opt-in: prompts", () => {
  const getPrompt = (who: Caller, args: Record<string, unknown>) =>
    rpc(demo.POST, who, "prompts/get", { name: "restock-plan", arguments: args });

  test("AdminService's restock-plan prompt is listed for alice and hidden from bob", async () => {
    const alice = await rpc(demo.POST, "alice", "prompts/list");
    expect(alice.message?.result?.prompts).toEqual([
      {
        name: "restock-plan",
        title: "Restock plan",
        description: "Suggest which books to restock, based on current stock levels",
        arguments: [{ name: "threshold", required: true }],
      },
    ]);
    const discover = await rpc(demo.POST, "alice", "server/discover");
    expect(discover.message?.result?.capabilities).toMatchObject({
      prompts: { listChanged: false },
    });
    // Bob cannot reach AdminService: no prompts at all, and asking by name fails.
    const bob = await rpc(demo.POST, "bob", "server/discover");
    expect(bob.message?.result?.capabilities).not.toHaveProperty("prompts");
    expect((await getPrompt("bob", { threshold: "5" })).message?.error).toBeDefined();
  });

  test("prompt arguments are validated and substituted", async () => {
    const ok = await getPrompt("alice", { threshold: "5" });
    expect(ok.message?.result).toMatchObject({
      description: "Suggest which books to restock, based on current stock levels",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "List books with stock below 5 and suggest a restock quantity for each.",
          },
        },
      ],
    });
    // Prompt arguments are strings on the wire; an Integer input must look like one.
    for (const args of [{}, { threshold: "five" }, { threshold: "5", other: "x" }]) {
      expect((await getPrompt("alice", args)).message?.error).toMatchObject({ code: -32602 });
    }
  });
});

describe("opt-in: MCP Apps (issue #133)", () => {
  const MIME = "text/html;profile=mcp-app";
  const read = (uri: string) => rpc(demo.POST, "bob", "resources/read", { uri });

  test("bookCard is registered as an app tool linked to ui://bookshop/book-card.html", async () => {
    const tools = (await listTools(demo.POST, "bob")).message?.result?.tools as {
      name: string;
      _meta?: Record<string, unknown>;
    }[];
    expect(tools.find((t) => t.name === "CatalogService_bookCard")?._meta).toMatchObject({
      ui: { resourceUri: "ui://bookshop/book-card.html" },
    });
    // The UI resources are listed: a host reads them before the tool is called.
    const list = await rpc(demo.POST, "bob", "resources/list");
    expect(list.message?.result?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "ui://bookshop/book-card.html", mimeType: MIME }),
        expect.objectContaining({ uri: "ui://bookshop/stock-chart.html", mimeType: MIME }),
      ]),
    );
  });

  test("the ui resource serves demo/app/mcp-apps/book-card.html with the MCP App mime type", async () => {
    const html = readFileSync(path.join(DEMO_DIR, "app", "mcp-apps", "book-card.html"), "utf8");
    expect((await read("ui://bookshop/book-card.html")).message?.result).toMatchObject({
      contents: [{ uri: "ui://bookshop/book-card.html", mimeType: MIME, text: html }],
    });
  });

  test("a hook lets the app supply its own resource registration", async () => {
    // demo/server.js: cds.on('mcp:apps', apps => apps.register('ui://bookshop/stock-chart.html', …))
    const res = await read("ui://bookshop/stock-chart.html");
    expect(res.message?.result).toMatchObject({
      contents: [{ mimeType: MIME, text: expect.stringContaining("Stock by genre") }],
    });
    // Only UI linked from the caller's tools is served.
    expect((await read("ui://bookshop/nothing.html")).message?.error).toMatchObject({
      code: -32602,
    });
  });
});

describe("opt-in: confirmation (MRTR)", () => {
  /** Bob's submitted order (demo data). */
  const ORDER = "7e2f9c58-1c1d-4c0b-9a7a-6d1f0b5e0a01";
  const ELICITING = { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } };
  const cancel = (extra: Record<string, unknown> = {}, reason = "moved") =>
    rpc(
      demo.POST,
      "bob",
      "tools/call",
      { name: "OrdersService_Orders_cancel", arguments: { ID: ORDER, reason }, ...extra },
      { meta: ELICITING },
    );
  /** The requestState of the form the server asked with, for these arguments. */
  const asked = async (reason = "moved") =>
    (await cancel({}, reason)).message?.result?.requestState as string;
  const ACCEPT = { confirm: { action: "accept", content: {} } };
  const status = async () =>
    (
      (await callTool("bob", "OrdersService_Orders_get", { ID: ORDER })).structuredContent as {
        status: string;
      }
    ).status;

  test("calling cancel returns resultType input_required with a confirmation request", async () => {
    const res = await cancel();
    expect(res.message?.result).not.toHaveProperty("content");
    expect(res.message?.result).toMatchObject({
      resultType: "input_required",
      requestState: expect.any(String),
      inputRequests: {
        confirm: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: expect.stringMatching(/^Confirm OrdersService\.Orders\.cancel/),
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
    });
    expect(await status()).toBe("submitted");
  });

  test("retrying with a declining inputResponse leaves the order unchanged", async () => {
    for (const action of ["decline", "cancel"]) {
      const res = await cancel({ inputResponses: { confirm: { action } } });
      expect(res.message?.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CONFIRMATION_DECLINED" } },
      });
    }
    expect(await status()).toBe("submitted");
  });

  test("an accept the server did not ask for, or for other arguments, asks again", async () => {
    // A first call that already carries an accept: no form was shown for it.
    const unasked = await cancel({ inputResponses: ACCEPT });
    expect(unasked.message?.result).toMatchObject({ resultType: "input_required" });
    // The form was for reason "moved"; the retry changed it.
    const changed = await cancel({ inputResponses: ACCEPT, requestState: await asked() }, "other");
    expect(changed.message?.result).toMatchObject({ resultType: "input_required" });
    expect(await status()).toBe("submitted");
  });

  test("retrying with an accepting inputResponse cancels the order", async () => {
    const res = await cancel({ inputResponses: ACCEPT, requestState: await asked() });
    expect(res.message?.result).toMatchObject({
      structuredContent: { value: { ID: ORDER, status: "cancelled", reason: "moved" } },
    });
    expect(await status()).toBe("cancelled");
  });

  test("a 2026-07-28 client that cannot elicit gets a clear isError", async () => {
    const res = await callTool("bob", "OrdersService_Orders_cancel", { ID: ORDER, reason: "x" });
    expect(res.structuredContent).toEqual({
      error: expect.objectContaining({
        code: "CONFIRMATION_REQUIRED",
        message: expect.stringMatching(/elicitation/),
      }),
    });
  });
});

describe("opt-in: completion", () => {
  // MCP completes resource-template variables (and prompt arguments), not tool arguments, so
  // @mcp.completion completes the key of an @mcp.resource entity (AdminService.Authors:ID).
  const complete = (who: Caller, uri: string, value: string) =>
    rpc(demo.POST, who, "completion/complete", {
      ref: { type: "ref/resource", uri },
      argument: { name: "key", value },
    });

  test("completion/complete for the Authors resource key returns matching author IDs", async () => {
    const res = await complete("alice", "cap://AdminService/Authors/{key}", "10");
    expect(res.message?.result?.completion).toMatchObject({
      values: ["101", "107"],
      hasMore: false,
    });
    const discover = await rpc(demo.POST, "alice", "server/discover");
    expect(discover.message?.result?.capabilities).toHaveProperty("completions");
  });

  test("resources without @mcp.completion, and callers who cannot read them, get no completions", async () => {
    // Bob cannot reach AdminService: there is no such template for him.
    expect(
      (await complete("bob", "cap://AdminService/Authors/{key}", "1")).message?.error,
    ).toBeDefined();
    const discover = await rpc(demo.POST, "bob", "server/discover");
    expect(discover.message?.result?.capabilities).not.toHaveProperty("completions");
  });
});
