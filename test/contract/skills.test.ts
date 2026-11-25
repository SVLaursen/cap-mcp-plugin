import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setUpSkills } from "../../src/adapter/skills";

/** Skills over MCP (ADR 0016): loading the folder once at startup, and what it reports. */

const skill = (name: string, description = "Does a thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("loading the skills folder", () => {
  let root: string;
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cap-mcp-skills-"));
    write("skills/handle-return/SKILL.md", skill("handle-return"));
    write("skills/handle-return/references/checklist.md", "# Checklist\n");
  });
  afterEach(() => {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  test("without the key there is no catalog and nothing to report", async () => {
    expect(await setUpSkills(undefined, root)).toEqual({ diagnostics: [], uris: [] });
  });

  test("valid skills are loaded once, listed by their SKILL.md URI", async () => {
    write("skills/restock/SKILL.md", skill("restock"));
    const setup = await setUpSkills("skills", root);
    expect(setup.diagnostics).toEqual([]);
    expect(setup.uris).toEqual(["skill://handle-return/SKILL.md", "skill://restock/SKILL.md"]);
    expect(setup.catalog?.entries.map((e) => e.uri)).toEqual(setup.uris);
  });

  test("an invalid skill is a warning naming its file, and is not served at all", async () => {
    write("skills/bad-name/SKILL.md", skill("other-name"));
    write("skills/no-desc/SKILL.md", "---\nname: no-desc\n---\nbody\n");
    write("skills/linked/SKILL.md", skill("linked"));
    symlinkSync("/etc/hosts", path.join(root, "skills/linked/hosts.md"));
    const setup = await setUpSkills("skills", root);
    expect(setup.uris).toEqual(["skill://handle-return/SKILL.md"]);
    expect(setup.diagnostics.map((d) => [d.level, d.code, d.target])).toEqual([
      ["warn", "INVALID_SKILL", "skills/bad-name/SKILL.md"],
      ["warn", "INVALID_SKILL", "skills/linked/hosts.md"],
      ["warn", "INVALID_SKILL", "skills/no-desc/SKILL.md"],
    ]);
    expect(setup.diagnostics[0]?.message).toMatch(/must match/);
  });

  test("a skill over the limit of 512 files is not served", async () => {
    for (let i = 0; i < 512; i++) write(`skills/handle-return/references/f${i}.md`, "x");
    const setup = await setUpSkills("skills", root);
    expect(setup.uris).toEqual([]);
    expect(setup.catalog).toBeUndefined();
    expect(setup.diagnostics.map((d) => [d.code, d.target, d.message])).toEqual([
      ["INVALID_SKILL", "skills", expect.stringMatching(/no skills found/)],
      [
        "INVALID_SKILL",
        "skills/handle-return",
        expect.stringMatching(/exceeds the limit of 512 files/),
      ],
    ]);
  });

  test("a skill over 16 MiB is not served; the others are", async () => {
    write("skills/big/SKILL.md", skill("big"));
    write("skills/big/data.bin", "x".repeat(16 * 1024 * 1024));
    const setup = await setUpSkills("skills", root);
    expect(setup.uris).toEqual(["skill://handle-return/SKILL.md"]);
    expect(setup.diagnostics.map((d) => [d.code, d.target])).toEqual([
      ["INVALID_SKILL", "skills/big"],
    ]);
  });

  test("a folder without a valid skill gives no catalog", async () => {
    write("other/broken/SKILL.md", "no frontmatter");
    const setup = await setUpSkills("other", root);
    expect(setup.catalog).toBeUndefined();
    expect(setup.uris).toEqual([]);
  });

  test("a folder that cannot be used is an INVALID_CONFIG error and serves no skills", async () => {
    const missing = await setUpSkills("missing", root);
    expect(missing.catalog).toBeUndefined();
    expect(missing.diagnostics.map((d) => [d.level, d.code, d.target])).toEqual([
      ["error", "INVALID_CONFIG", "cds.mcp.skills"],
    ]);
  });

  test("a folder that cannot be read is an INVALID_CONFIG error and serves no skills", async () => {
    chmodSync(path.join(root, "skills"), 0o000);
    try {
      const setup = await setUpSkills("skills", root);
      expect(setup.catalog).toBeUndefined();
      expect(setup.diagnostics).toEqual([
        expect.objectContaining({
          level: "error",
          code: "INVALID_CONFIG",
          target: "cds.mcp.skills",
          message: expect.stringMatching(/^cds\.mcp\.skills folder skills cannot be read/),
        }),
      ]);
    } finally {
      chmodSync(path.join(root, "skills"), 0o755);
    }
  });
});
