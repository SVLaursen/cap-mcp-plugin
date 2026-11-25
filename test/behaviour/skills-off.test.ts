import cds from "@sap/cds";
import { bootDemo } from "../helpers/demo";
import { legacyInitialize, rpc } from "../helpers/mcp";

/**
 * Skills are opt-in (ADR 0004, 0016): the demo without `cds.mcp.skills` serves no skill and
 * declares nothing for them. Compared with the capabilities the demo had before skills, not
 * with a frozen copy of whole results (a package version in _meta would break it at release).
 */
const demo = bootDemo();
const env = cds.env as unknown as { mcp?: Record<string, unknown> };
const { skills: _skills, ...withoutSkills } = env.mcp ?? {};
env.mcp = withoutSkills;

const uris = (items: unknown, key: "uri" | "uriTemplate") =>
  (items as Record<string, string>[]).map((item) => item[key] ?? "");

test("server/discover and initialize declare no extensions: the capabilities from before skills", async () => {
  const discover = await rpc(demo.POST, "bob", "server/discover");
  expect(discover.message?.result?.capabilities).toEqual({
    tools: { listChanged: false },
    resources: { listChanged: false },
    completions: {},
  });
  const init = await legacyInitialize(demo.POST, "bob");
  expect(init.message?.result?.capabilities).not.toHaveProperty("extensions");
});

test("no skill:// resource or template is listed", async () => {
  for (const who of ["alice", "bob"] as const) {
    const list = await rpc(demo.POST, who, "resources/list");
    const templates = await rpc(demo.POST, who, "resources/templates/list");
    expect(
      uris(list.message?.result?.resources, "uri").filter((u) => u.startsWith("skill:")),
    ).toEqual([]);
    expect(
      uris(templates.message?.result?.resourceTemplates, "uriTemplate").filter((u) =>
        u.startsWith("skill:"),
      ),
    ).toEqual([]);
  }
});

test("skills/list, skills/get and resources/directory/read are unknown methods", async () => {
  for (const [method, params] of [
    ["skills/list", {}],
    ["skills/get", { uri: "skill://handle-return/SKILL.md" }],
    ["resources/directory/read", { uri: "skill://handle-return" }],
  ] as const) {
    expect((await rpc(demo.POST, "bob", method, params)).message?.error?.code).toBe(-32601);
  }
});

test("a skill file is not readable", async () => {
  const res = await rpc(demo.POST, "bob", "resources/read", {
    uri: "skill://handle-return/SKILL.md",
  });
  expect(res.message?.error?.code).toBe(-32602);
});

test("hint providers see no skills, so the demo names none (ADR 0017)", async () => {
  const res = await rpc(demo.POST, "carol", "server/discover");
  expect(res.message?.result?.instructions).toContain("Shop policies are MCP resources.");
  expect(res.message?.result?.instructions).not.toContain("handle-return");
});
