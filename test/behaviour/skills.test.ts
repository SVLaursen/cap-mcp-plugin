import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEMO_DIR, bootDemo } from "../helpers/demo";
import { rpc } from "../helpers/mcp";

/**
 * Skills over MCP (ADR 0016) on the demo: `cds.mcp.skills` names demo/mcp-skills, which holds
 * one skill, handle-return, with SKILL.md and references/checklist.md.
 */
const demo = bootDemo();

const SKILL = "skill://handle-return/SKILL.md";
const FILES = {
  [SKILL]: path.join(DEMO_DIR, "mcp-skills/handle-return/SKILL.md"),
  "skill://handle-return/references/checklist.md": path.join(
    DEMO_DIR,
    "mcp-skills/handle-return/references/checklist.md",
  ),
};
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: { uri: string; digest: string; size: number }[];
}

describe("serving skills", () => {
  test("server/discover declares the extension, with directoryRead, and resources", async () => {
    const res = await rpc(demo.POST, "bob", "server/discover");
    expect(res.message?.result?.capabilities).toMatchObject({
      resources: { listChanged: false },
      extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
    });
  });

  test("skills/list answers with the skill, its frontmatter verbatim, and cache fields", async () => {
    const res = await rpc(demo.POST, "bob", "skills/list");
    expect(res.message?.result).toMatchObject({
      resultType: "complete",
      ttlMs: 60_000,
      cacheScope: "private",
    });
    const skills = res.message?.result?.skills as SkillEntry[];
    expect(skills.map((s) => s.uri)).toEqual([SKILL]);
    expect(skills[0]?.frontmatter).toEqual({
      name: "handle-return",
      description: expect.stringMatching(/^Handle a customer's request to return or cancel/),
    });
  });

  test("skills/get answers for the skill; an unknown skill URI is -32602", async () => {
    const list = (await rpc(demo.POST, "bob", "skills/list")).message?.result
      ?.skills as SkillEntry[];
    const res = await rpc(demo.POST, "bob", "skills/get", { uri: SKILL });
    expect(res.message?.result).toMatchObject({
      resultType: "complete",
      ttlMs: 60_000,
      cacheScope: "private",
      skill: list[0],
    });
    const unknown = await rpc(demo.POST, "bob", "skills/get", { uri: "skill://nope/SKILL.md" });
    expect(unknown.message?.error?.code).toBe(-32602);
  });

  test("every published file reads through resources/read, matching its digest and size", async () => {
    const [skill] = (await rpc(demo.POST, "bob", "skills/list")).message?.result
      ?.skills as SkillEntry[];
    expect(skill?.resources.map((r) => r.uri).sort()).toEqual(Object.keys(FILES).sort());
    for (const { uri, digest, size } of skill?.resources ?? []) {
      const bytes = readFileSync(FILES[uri as keyof typeof FILES]);
      expect({ digest, size }).toEqual({ digest: sha256(bytes), size: bytes.length });
      const read = await rpc(demo.POST, "bob", "resources/read", { uri });
      const [content] = read.message?.result?.contents as { uri: string; text: string }[];
      expect(content?.uri).toBe(uri);
      expect(sha256(Buffer.from(content?.text ?? "", "utf8"))).toBe(digest);
    }
  });

  test("resources/directory/read lists a skill's folder; SKILL.md is in resources/list", async () => {
    const dir = await rpc(demo.POST, "bob", "resources/directory/read", {
      uri: "skill://handle-return",
    });
    expect(dir.message?.result?.resources).toEqual([
      expect.objectContaining({ uri: SKILL, name: "SKILL.md" }),
      expect.objectContaining({
        uri: "skill://handle-return/references",
        mimeType: "inode/directory",
      }),
    ]);
    const list = await rpc(demo.POST, "bob", "resources/list");
    expect(list.message?.result?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: SKILL, name: "handle-return", mimeType: "text/markdown" }),
      ]),
    );
  });
});
