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

describe("mcp:resources: reading", () => {
  const read = (who: Caller, uri: string, headers: Record<string, string> = {}) =>
    rpc(demo.POST, who, "resources/read", { uri }, { headers });

  test("a public note reads as Markdown", async () => {
    const res = await read("bob", `${NOTES}returns-policy.md`);
    expect(res.message?.result?.contents).toEqual([
      {
        uri: `${NOTES}returns-policy.md`,
        mimeType: "text/markdown",
        text: expect.stringContaining("within 30 days"),
      },
    ]);
  });

  test("read gets the request's locale from cds.context", async () => {
    const res = await read("alice", `${NOTES}stock-policy.md`, { "accept-language": "de" });
    const [content] = res.message?.result?.contents as { text: string }[];
    expect(content?.text).toContain("Stock policy (de)");
  });

  test("a note whose read throws a 404 is resource-not-found", async () => {
    const uri = `${NOTES}missing.md`;
    const res = await read("bob", uri);
    expect(res.message?.error).toMatchObject({ code: -32602, data: { uri } });
    expect(JSON.stringify(res.message)).not.toMatch(/was deleted/);
  });

  test("bob reading the admins' note gets the same answer as for a note that does not exist", async () => {
    const hidden = await read("bob", `${NOTES}stock-policy.md`);
    const unknown = await read("bob", `${NOTES}no-such-note.md`);
    const shape = (res: typeof hidden, uri: string) =>
      JSON.stringify(res.message?.error).replaceAll(uri, "<uri>");
    expect(hidden.message?.error).toBeDefined();
    expect(shape(hidden, `${NOTES}stock-policy.md`)).toBe(
      shape(unknown, `${NOTES}no-such-note.md`),
    );
  });
});

describe("mcp:resources: the topics template", () => {
  const read = (uri: string) => rpc(demo.POST, "bob", "resources/read", { uri });

  test("a path with slashes reads through the template", async () => {
    const uri = `${NOTES}topics/gifts/wrapping.md`;
    const res = await read(uri);
    expect(res.message?.result?.contents).toEqual([
      { uri, mimeType: "text/markdown", text: expect.stringContaining("Gift wrapping") },
    ]);
  });

  test("an unknown topic is resource-not-found", async () => {
    const uri = `${NOTES}topics/nothing.md`;
    expect((await read(uri)).message?.error).toMatchObject({ code: -32602, data: { uri } });
  });

  test("completion offers the topic paths", async () => {
    const res = await rpc(demo.POST, "bob", "completion/complete", {
      ref: { type: "ref/resource", uri: `${NOTES}topics/{+path}` },
      argument: { name: "path", value: "g" },
    });
    expect(res.message?.result?.completion).toMatchObject({
      values: ["gifts/wrapping.md"],
      hasMore: false,
    });
  });
});
