import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { callTool, listTools, rpc } from "../helpers/mcp";

/**
 * M4 — cds.env.mcp (docs/annotations.md, Configuration). Set before the demo is served, as an
 * app's package.json or .cdsrc would.
 */
const demo = bootDemo();
(cds.env as unknown as { mcp: unknown }).mcp = {
  path: "/ai/mcp",
  name: "bookshop",
  version: "1.2.3",
  limits: { maxRows: 3, defaultRows: 2 },
};
const at = { path: "/ai/mcp" };

describe("configuration (cds.env.mcp)", () => {
  test("path moves the endpoint; nothing is left at /mcp", async () => {
    expect((await listTools(demo.POST, "bob", at)).status).toBe(200);
    expect((await listTools(demo.POST, "bob")).status).toBe(404);
  });

  test("name and version are the server identity", async () => {
    const res = await rpc(demo.POST, "bob", "server/discover", {}, at);
    expect(res.message?.result?._meta).toEqual({
      "io.modelcontextprotocol/serverInfo": { name: "bookshop", version: "1.2.3" },
    });
  });

  test("limits shape the advertised schema and what the executor enforces alike", async () => {
    const tools = (await listTools(demo.POST, "bob", at)).message?.result?.tools as {
      name: string;
      inputSchema: { properties: { top: unknown } };
    }[];
    const query = tools.find((t) => t.name === "CatalogService_Books_query");
    expect(query?.inputSchema.properties.top).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 3,
      default: 2,
    });
    const page = await callTool(demo.POST, "bob", "CatalogService_Books_query", {}, at);
    expect(page.message?.result?.structuredContent).toMatchObject({
      rows: [expect.anything(), expect.anything()],
      nextCursor: expect.any(String),
    });
  });
});
