import { bootDemo, type DemoUser } from "../helpers/demo";
import { listTools, rpc } from "../helpers/mcp";
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
  test.todo("CatalogService_describe lists only CatalogService's exposed entities and fields");
  test.todo("the describe tool never mentions costPrice, email, AuditNotes or db-layer entities");
  test.todo("AdminService (compact) exposes the generic tool set, scoped to its entities");
});

describe("opt-in: resources", () => {
  test.todo("cap://AdminService/Authors/101 reads one author without email");
  test.todo("resources/list does not enumerate whole tables");
  test.todo("CatalogService entities (no @mcp.resource) have no resources");
});

describe("opt-in: prompts", () => {
  test.todo("AdminService's restock-plan prompt is listed for alice and hidden from bob");
  test.todo("prompt arguments are validated and substituted");
});

describe("opt-in: MCP Apps (issue #133)", () => {
  test.todo("bookCard is registered as an app tool linked to ui://bookshop/book-card.html");
  test.todo("the ui resource serves demo/app/mcp-apps/book-card.html with the MCP App mime type");
  test.todo("a hook lets the app supply its own resource registration");
});

describe("opt-in: confirmation (MRTR)", () => {
  test.todo("calling cancel returns resultType input_required with a confirmation request");
  test.todo("retrying with a declining inputResponse leaves the order unchanged");
  test.todo("retrying with an accepting inputResponse cancels the order");
});

describe("opt-in: completion", () => {
  test.todo("completion/complete for submitOrder.book returns matching book IDs");
  test.todo("parameters without @mcp.completion return no completions");
});
