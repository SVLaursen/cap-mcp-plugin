import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, readInstructions } from "../../src/config";

/** M6 — cds.env.mcp keys (docs/annotations.md, Configuration): camelCase, checked at startup. */
describe("configuration (cds.env.mcp)", () => {
  test("every documented key is read as given, with no diagnostics", () => {
    const raw = {
      path: "/ai/mcp",
      name: "bookshop",
      version: "1.2.3",
      allowedOrigins: ["https://claude.ai"],
      tenantHostPattern: "^(.*)-shop\\.example\\.com",
      instructions: { file: "mcp.md" },
      limits: { maxRows: 50, defaultRows: 10 },
    };
    expect(readConfig(raw)).toEqual({ config: raw, diagnostics: [] });
    expect(readConfig(undefined)).toEqual({ config: {}, diagnostics: [] });
  });

  test("an unknown key is a warning and is ignored", () => {
    expect(readConfig({ paht: "/x", limits: { maxRow: 5 } })).toEqual({
      config: { limits: {} },
      diagnostics: [
        {
          level: "warn",
          code: "UNKNOWN_CONFIG",
          target: "cds.mcp.paht",
          message: "Unknown setting cds.mcp.paht; it has no effect",
        },
        {
          level: "warn",
          code: "UNKNOWN_CONFIG",
          target: "cds.mcp.limits.maxRow",
          message: "Unknown setting cds.mcp.limits.maxRow; it has no effect",
        },
      ],
    });
  });

  test("a value of the wrong shape is an error, and the default is used instead", () => {
    const { config, diagnostics } = readConfig({
      path: "mcp",
      name: 42,
      allowedOrigins: "https://claude.ai",
      instructions: { path: "x.md" },
      limits: { maxRows: 0, defaultRows: 2.5 },
    });
    expect(config).toEqual({ limits: {} });
    expect(diagnostics.map((d) => [d.level, d.code, d.target])).toEqual([
      ["error", "INVALID_CONFIG", "cds.mcp.path"],
      ["error", "INVALID_CONFIG", "cds.mcp.name"],
      ["error", "INVALID_CONFIG", "cds.mcp.allowedOrigins"],
      ["error", "INVALID_CONFIG", "cds.mcp.instructions"],
      ["error", "INVALID_CONFIG", "cds.mcp.limits.maxRows"],
      ["error", "INVALID_CONFIG", "cds.mcp.limits.defaultRows"],
    ]);
    expect(diagnostics[0]?.message).toBe(
      'cds.mcp.path must be a path starting with "/"; using the default',
    );
  });

  test("defaultRows above maxRows is an error; the page size is capped at maxRows", () => {
    expect(readConfig({ limits: { maxRows: 5, defaultRows: 10 } })).toEqual({
      config: { limits: { maxRows: 5, defaultRows: 5 } },
      diagnostics: [
        {
          level: "error",
          code: "INVALID_CONFIG",
          target: "cds.mcp.limits.defaultRows",
          message: "cds.mcp.limits.defaultRows (10) is above maxRows (5); using 5",
        },
      ],
    });
  });

  test("maxRows below the default page size makes it the page size too", () => {
    expect(readConfig({ limits: { maxRows: 10 } })).toEqual({
      config: { limits: { maxRows: 10, defaultRows: 10 } },
      diagnostics: [],
    });
  });

  test("the whole block as a JSON string (v1 accepted that) is an error", () => {
    expect(readConfig('{"name":"x"}')).toEqual({
      config: {},
      diagnostics: [
        {
          level: "error",
          code: "INVALID_CONFIG",
          target: "cds.mcp",
          message: "cds.mcp must be an object (a JSON string is not read); using the defaults",
        },
      ],
    });
  });
});

describe("instructions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cap-mcp-config-"));
    writeFileSync(path.join(root, "mcp.md"), "Use the catalog first.\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a string is the instructions; { file } is read relative to the app root", () => {
    expect(readInstructions("Be brief.", root)).toEqual({ text: "Be brief." });
    expect(readInstructions({ file: "mcp.md" }, root)).toEqual({
      text: "Use the catalog first.\n",
    });
    expect(readInstructions(undefined, root)).toEqual({});
  });

  test("a missing file is an error; the server then has no instructions", () => {
    expect(readInstructions({ file: "missing.md" }, root)).toEqual({
      diagnostic: {
        level: "error",
        code: "INVALID_CONFIG",
        target: "cds.mcp.instructions",
        message:
          "cds.mcp.instructions file missing.md cannot be read; serving without instructions",
      },
    });
  });
});
