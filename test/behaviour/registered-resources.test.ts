import { bootDemo } from "../helpers/demo";
import { rpc, type Caller } from "../helpers/mcp";

/**
 * Resources from code (ADR 0013) over /mcp: what demo/server.js registers through
 * `mcp:resources`, as each demo user gets it.
 */
const demo = bootDemo();

const NOTES = "notes://bookshop/";

async function notes(who: Caller): Promise<string[]> {
  const res = await rpc(demo.POST, who, "resources/list");
  const all = res.message?.result?.resources as { uri: string }[];
  return all.map((r) => r.uri).filter((uri) => uri.startsWith(NOTES));
}

describe("mcp:resources: listing", () => {
  test("everyone sees the public notes; only admins see the stock policy", async () => {
    const shared = [`${NOTES}missing.md`, `${NOTES}returns-policy.md`];
    expect(await notes("alice")).toEqual([
      `${NOTES}missing.md`,
      `${NOTES}returns-policy.md`,
      `${NOTES}stock-policy.md`,
    ]);
    expect(await notes("bob")).toEqual(shared);
    expect(await notes("carol")).toEqual(shared);
    expect(await notes("anonymous")).toEqual(shared);
  });

  test("the list carries title, description and MIME type, after the MCP Apps, cached privately", async () => {
    const res = await rpc(demo.POST, "bob", "resources/list");
    const all = res.message?.result?.resources as { uri: string }[];
    expect(all.find((r) => r.uri === `${NOTES}returns-policy.md`)).toEqual({
      uri: `${NOTES}returns-policy.md`,
      name: "returns-policy",
      title: "Returns policy",
      description: "How customers return books",
      mimeType: "text/markdown",
    });
    const firstNote = all.findIndex((r) => r.uri.startsWith(NOTES));
    expect(all.slice(0, firstNote).every((r) => r.uri.startsWith("ui://"))).toBe(true);
    expect(res.message?.result).toMatchObject({ cacheScope: "private" });
  });

  test("the topics template is listed for everyone, anonymous included", async () => {
    const res = await rpc(demo.POST, "anonymous", "resources/templates/list");
    expect(res.message?.result?.resourceTemplates).toContainEqual(
      expect.objectContaining({ uriTemplate: `${NOTES}topics/{+path}`, name: "bookshop-topics" }),
    );
  });
});
