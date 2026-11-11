/**
 * Names and descriptions agents see (docs/annotations.md, Names and descriptions): the demo's
 * @mcp.name, @mcp.description and @mcp.hint targets, over /mcp as a client sees them.
 */
import { bootDemo } from "../helpers/demo";
import { listTools } from "../helpers/mcp";

const demo = bootDemo();

type Tool = {
  name: string;
  title?: string;
  description: string;
  outputSchema?: { properties?: Record<string, { description?: string }> };
};

async function tools(): Promise<Record<string, Tool>> {
  const res = await listTools(demo.POST, "bob");
  const list = res.message?.result?.tools as Tool[];
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

describe("names and descriptions in the demo", () => {
  test("@mcp.name sets the tool title (CatalogService.stockByGenre)", async () => {
    expect((await tools()).CatalogService_stockByGenre?.title).toBe("Stock by genre");
  });

  test("@mcp.description replaces the description agents read (CatalogService.Authors)", async () => {
    const query = (await tools()).CatalogService_Authors_query;
    expect(query?.description).toContain("Authors of the books in the catalog");
  });

  test("@mcp.hint describes a field to agents (CatalogService.Books.status)", async () => {
    const get = (await tools()).CatalogService_Books_get;
    expect(get?.outputSchema?.properties?.status?.description).toBe(
      "available or discontinued; only available books can be ordered",
    );
  });
});
