import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mcpBuildTask } from "../../src/cli/build";

/**
 * The `cds build` task in process (cds-cli.test.ts runs the real CLI, which coverage cannot see).
 * The base class stands in for cds-dk's build Plugin API: task paths, copy, pushFile, pushMessage.
 */
const WARNING = Symbol("warning");

function buildApp(mcp: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "cap-mcp-build-"));
  const dest = path.join(root, "gen");
  const files: string[] = [];
  const messages: string[] = [];
  class Plugin {
    task = { src: root, dest };
    copy(src: string) {
      return {
        to: async (to: string) => {
          const target = path.resolve(dest, to);
          mkdirSync(path.dirname(target), { recursive: true });
          cpSync(src, target, { recursive: true });
          files.push(target);
        },
      };
    }
    pushFile(file: string) {
      files.push(file);
    }
    pushMessage(message: string) {
      messages.push(message);
    }
  }
  const Task = mcpBuildTask({
    root,
    env: { mcp },
    build: { Plugin: Plugin as never, WARNING } as never,
  });
  const run = () => (new Task() as unknown as { build(): Promise<void> }).build();
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  return {
    root,
    dest,
    files,
    messages,
    run,
    write,
    Task,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const skill = (name: string) => `---\nname: ${name}\ndescription: x\n---\n`;

test("runs only when an instructions file or a skills folder is configured", () => {
  for (const [mcp, expected] of [
    [{}, false],
    [{ instructions: "inline text" }, false],
    [{ instructions: { file: "mcp.md" } }, true],
    [{ skills: "mcp-skills" }, true],
  ] as const) {
    const app = buildApp(mcp);
    expect((app.Task as unknown as { hasTask(): boolean }).hasTask()).toBe(expected);
    app.done();
  }
});

test("copies the instructions file and exactly the served skills' files", async () => {
  const app = buildApp({ instructions: { file: "docs/mcp.md" }, skills: "mcp-skills" });
  try {
    app.write("docs/mcp.md", "Be brief.\n");
    app.write("mcp-skills/a/SKILL.md", skill("a"));
    app.write("mcp-skills/a/references/r.md", "# R\n");
    app.write("mcp-skills/a/.env", "SECRET=1\n");
    app.write("mcp-skills/bad/SKILL.md", skill("other"));
    await app.run();
    const gen = path.join(app.dest, "srv");
    expect(readFileSync(path.join(gen, "docs/mcp.md"), "utf8")).toBe("Be brief.\n");
    expect(readFileSync(path.join(gen, "mcp-skills/a/references/r.md"), "utf8")).toBe("# R\n");
    expect(existsSync(path.join(gen, "mcp-skills/a/.env"))).toBe(false);
    expect(existsSync(path.join(gen, "mcp-skills/bad"))).toBe(false);
    expect(app.messages).toEqual([
      expect.stringMatching(/^MCP skills folder mcp-skills: mcp-skills\/bad\/SKILL\.md: /),
    ]);
  } finally {
    app.done();
  }
});

test("a skills folder that is absolute, missing, outside the app or without skills copies nothing", async () => {
  const app = buildApp({});
  const outside = mkdtempSync(path.join(tmpdir(), "cap-mcp-outside-"));
  try {
    const runWith = async (skills: string) => {
      const next = buildApp({ skills });
      try {
        if (skills === "linked") symlinkSync(outside, path.join(next.root, "linked"));
        if (skills === "empty") mkdirSync(path.join(next.root, "empty"));
        await next.run();
        return { messages: next.messages, files: next.files };
      } finally {
        next.done();
      }
    };
    expect((await runWith("/abs/skills")).messages).toEqual([
      "MCP skills folder /abs/skills is an absolute path; the deployed app reads it there, so it is not copied",
    ]);
    expect((await runWith("missing")).messages).toEqual([
      "MCP skills folder missing does not exist; not copied",
    ]);
    expect((await runWith("linked")).messages).toEqual([
      "MCP skills folder linked is outside the app root; not copied",
    ]);
    const empty = await runWith("empty");
    expect(empty.files).toEqual([]);
    expect(empty.messages).toEqual([expect.stringMatching(/no skills found/)]);
  } finally {
    app.done();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("an instructions file that is absolute or missing is a warning and is not copied", async () => {
  for (const [file, message] of [
    ["/abs/mcp.md", /is an absolute path/],
    ["docs/missing.md", /not found; not copied/],
  ] as const) {
    const app = buildApp({ instructions: { file } });
    try {
      await app.run();
      expect(app.files).toEqual([]);
      expect(app.messages).toEqual([expect.stringMatching(message)]);
    } finally {
      app.done();
    }
  }
});
