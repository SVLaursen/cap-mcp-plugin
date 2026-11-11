import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { callTool, listTools } from "../helpers/mcp";

/**
 * CAP's global row limit (`cds.query.limit.max`) caps the query tools' `top` the way it caps
 * OData's `$top`. Set before the demo is served, as an app's package.json would.
 */
const demo = bootDemo();
(cds.env as unknown as { query: { limit: Record<string, number> } }).query.limit.max = 4;

test("the global max caps what the tools advertise and what CAP returns", async () => {
  const tools = (await listTools(demo.POST, "bob")).message?.result?.tools as {
    name: string;
    inputSchema: { properties: { top: unknown } };
  }[];
  const top = (name: string) => tools.find((t) => t.name === name)?.inputSchema.properties.top;
  expect(top("CatalogService_Books_query")).toEqual({
    type: "integer",
    minimum: 1,
    maximum: 4,
    default: 4,
  });
  // The entity's own @cds.query.limit is lower still.
  expect(top("CatalogService_Authors_query")).toMatchObject({ maximum: 3, default: 2 });
  const page = await callTool(demo.POST, "bob", "CatalogService_Books_query", {});
  expect(page.message?.result?.structuredContent).toMatchObject({
    rows: Array.from({ length: 4 }, () => expect.anything()),
    total: 5,
    nextCursor: expect.any(String),
  });
});
