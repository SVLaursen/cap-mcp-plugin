import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import {
  SKILLS_EXTENSION_ID,
  memorySkillFiles,
  SkillsExtension,
} from "@modelcontextprotocol/server/ext/skills";
import { serverFactory } from "../../src/adapter";
import { setUpSkills } from "../../src/adapter/skills";
import { registryCache } from "../../src/exposure-registry";
import { compileSnippet } from "../helpers/snippet";

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

/**
 * `attach` is marked experimental in the SDK (ADR 0016, decision 8): pin what the plugin relies
 * on, so an SDK upgrade that changes the wiring fails here first.
 */
describe("the SDK's skills wiring we rely on", () => {
  const call = async (catalog: SkillsExtension, method: string, params = {}) => {
    const handler = createMcpHandler(() => {
      // As our factory builds it: resources declared first, listChanged off.
      const server = new McpServer(
        { name: "t", version: "0" },
        { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
      );
      catalog.attach(server);
      return server;
    });
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
    return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number } };
  };

  test("one catalog attaches to a fresh server per request: extension, template, methods", async () => {
    expect(SKILLS_EXTENSION_ID).toBe("io.modelcontextprotocol/skills");
    const catalog = await SkillsExtension.load(memorySkillFiles({ "a/SKILL.md": skill("a") }));
    for (let i = 0; i < 2; i++) {
      expect((await call(catalog, "server/discover")).result?.capabilities).toEqual({
        tools: { listChanged: false },
        resources: { listChanged: false },
        extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
      });
    }
    expect((await call(catalog, "resources/templates/list")).result?.resourceTemplates).toEqual([
      { name: "io.modelcontextprotocol/skills", uriTemplate: "skill://{+path}" },
    ]);
    const list = await call(catalog, "skills/list");
    expect((list.result?.skills as { uri: string }[]).map((s) => s.uri)).toEqual([
      "skill://a/SKILL.md",
    ]);
    expect(
      (await call(catalog, "skills/get", { uri: "skill://a/SKILL.md" })).result,
    ).toHaveProperty("skill");
  });
});

describe("the resources capability with skills (ADR 0016)", () => {
  test("a caller with no other resource gets resources with listChanged off and our cache hints", async () => {
    const model = compileSnippet(`@mcp service S { entity Books { key ID : Integer; } }`);
    const catalog = await SkillsExtension.load(memorySkillFiles({ "a/SKILL.md": skill("a") }), {
      cacheHint: { ttlMs: 60_000, cacheScope: "private" },
    });
    const factory = (skills?: SkillsExtension) =>
      createMcpHandler(
        serverFactory({
          serverInfo: { name: "t", version: "0" },
          context: () => ({ user: { id: "u", is: () => false } }),
          model: () => model,
          registryFor: registryCache(),
          services: {},
          log: { error: () => undefined },
          ...(skills && { skills }),
        }),
      );
    const ask = async (handler: ReturnType<typeof factory>, method: string) => {
      const res = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      return ((await res.json()) as { result: Record<string, unknown> }).result;
    };
    // Without skills this caller has no resources at all.
    expect((await ask(factory(), "server/discover")).capabilities).toEqual({
      tools: { listChanged: false },
    });
    const withSkills = factory(catalog);
    expect((await ask(withSkills, "server/discover")).capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
      extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
    });
    expect(await ask(withSkills, "resources/list")).toMatchObject({
      ttlMs: 60_000,
      cacheScope: "private",
    });
  });
});
