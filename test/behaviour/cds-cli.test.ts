import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { setUpSkills } from "../../src/adapter/skills";

/**
 * M6 — smoke tests: the real cds-dk CLI (`cds add mcp`, `cds build`) in a fresh app, with the
 * plugin installed.
 * The child process loads the plugin from lib/, built once for the behaviour tests
 * (test/build-lib.js).
 */
const ROOT = path.join(__dirname, "..", "..");
const CDS = path.join(ROOT, "node_modules", "@sap", "cds-dk", "bin", "cds.js");
let app: string;

/** Run the cds CLI in the app, in its own process, with the plugin from lib/. */
function cds(...args: string[]): string {
  const env = { ...process.env };
  delete env.CDS_CONFIG; // test/setup-env.js: the CLI must load the plugin from lib/
  return execFileSync(process.execPath, [CDS, ...args], { cwd: app, env, encoding: "utf8" });
}

beforeAll(() => {
  app = mkdtempSync(path.join(tmpdir(), "cap-mcp-add-"));
  mkdirSync(path.join(app, "srv"));
  mkdirSync(path.join(app, "node_modules", "@sap"), { recursive: true });
  mkdirSync(path.join(app, "node_modules", "@gavdi"));
  symlinkSync(
    path.join(ROOT, "node_modules", "@sap", "cds"),
    path.join(app, "node_modules", "@sap", "cds"),
  );
  symlinkSync(ROOT, path.join(app, "node_modules", "@gavdi", "cap-mcp"));
  writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify(
      {
        name: "shop",
        version: "0.1.0",
        dependencies: { "@sap/cds": "^10", "@gavdi/cap-mcp": "^2.0.0-alpha.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(app, "srv", "cat.cds"),
    "service CatalogService { entity Books { key ID: Integer; } }\nservice AdminService { entity Notes { key ID: Integer; } }\n" +
      "@cds.external service ExternalAPI { entity Things { key ID: Integer; } }\n",
  );
}, 60_000);
afterAll(() => app && rmSync(app, { recursive: true, force: true }));

test("cds add mcp --service CatalogService annotates it and adds the mcp config", () => {
  cds("add", "mcp", "--service", "CatalogService");
  expect(readFileSync(path.join(app, "srv", "mcp.cds"), "utf8")).toContain(
    "annotate CatalogService with @mcp;",
  );
  const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
  expect(pkg.cds).toEqual({ mcp: { name: "shop", version: "0.1.0" } });
  const csn = JSON.parse(cds("compile", "srv", "--to", "json"));
  expect(csn.definitions.CatalogService["@mcp"]).toBe(true);
  expect(csn.definitions.AdminService["@mcp"]).toBeUndefined();
}, 60_000);

test("external services are not candidates", () => {
  expect(() => cds("add", "mcp", "--service", "ExternalAPI")).toThrow(
    /No service ExternalAPI \(AdminService, CatalogService\)/,
  );
});

test("running it again for another service adds to srv/mcp.cds instead of replacing it", () => {
  // A commented-out line is not an annotation that is already there.
  const file = path.join(app, "srv", "mcp.cds");
  writeFileSync(file, readFileSync(file, "utf8") + "// annotate AdminService with @mcp;\n");
  const pkg = path.join(app, "package.json");
  const before = readFileSync(pkg, "utf8").replace(/\n$/, "") + "   \n"; // unusual formatting
  writeFileSync(pkg, before);
  cds("add", "mcp", "--service", "AdminService");
  // Nothing to add to package.json: it is left byte for byte.
  expect(readFileSync(pkg, "utf8")).toBe(before);
  const updated = readFileSync(file, "utf8");
  expect(updated.match(/^annotate \w+ with @mcp;/gm)).toEqual([
    "annotate CatalogService with @mcp;",
    "annotate AdminService with @mcp;",
  ]);
  expect(existsSync(path.join(app, "srv", "mcp.cds"))).toBe(true);
}, 60_000);

test("cds build copies the instructions file to where the deployed app reads it", () => {
  mkdirSync(path.join(app, "docs"));
  writeFileSync(path.join(app, "docs", "mcp.md"), "Be brief.\n");
  const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
  pkg.cds.mcp.instructions = { file: "docs/mcp.md" };
  writeFileSync(path.join(app, "package.json"), JSON.stringify(pkg, null, 2));
  cds("build", "--production");
  expect(readFileSync(path.join(app, "gen", "srv", "docs", "mcp.md"), "utf8")).toBe("Be brief.\n");
}, 60_000);

test("cds build says when the instructions file cannot be copied (missing, or an absolute path)", () => {
  const pkgFile = path.join(app, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const env = { ...process.env };
  delete env.CDS_CONFIG; // test/setup-env.js: the CLI must load the plugin from lib/
  const build = () => {
    const out = spawnSync(process.execPath, [CDS, "build", "--production"], {
      cwd: app,
      env,
      encoding: "utf8",
    });
    return out.stdout + out.stderr;
  };
  pkg.cds.mcp.instructions = { file: "docs/missing.md" };
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  expect(build()).toMatch(/MCP instructions file docs\/missing\.md not found; not copied/);
  pkg.cds.mcp.instructions = { file: path.join(app, "docs", "mcp.md") };
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  expect(build()).toMatch(
    /MCP instructions file .*mcp\.md is an absolute path; the deployed app reads it there, so it is not copied/,
  );
}, 60_000);

describe("cds build and the skills folder (ADR 0016)", () => {
  const pkgFile = () => path.join(app, "package.json");
  const setSkills = (value: string) => {
    const pkg = JSON.parse(readFileSync(pkgFile(), "utf8"));
    delete pkg.cds.mcp.instructions;
    pkg.cds.mcp.skills = value;
    writeFileSync(pkgFile(), JSON.stringify(pkg, null, 2));
  };
  const build = () => {
    const env = { ...process.env };
    delete env.CDS_CONFIG; // test/setup-env.js: the CLI must load the plugin from lib/
    const out = spawnSync(process.execPath, [CDS, "build", "--production"], {
      cwd: app,
      env,
      encoding: "utf8",
    });
    return out.stdout + out.stderr;
  };

  test("copies exactly the skills the app serves, to where the deployed app reads them", async () => {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      writeFileSync(path.join(app, file), text);
    };
    const skill = (name: string) => `---\nname: ${name}\ndescription: x\n---\n`;
    write("mcp-skills/handle-return/SKILL.md", skill("handle-return"));
    write("mcp-skills/handle-return/references/checklist.md", "# Checklist\n");
    write("mcp-skills/handle-return/.env", "SECRET=1\n");
    // Skipped at runtime (a symlink in it): must not become a served skill in gen/.
    write("mcp-skills/linked/SKILL.md", skill("linked"));
    symlinkSync("/etc/hosts", path.join(app, "mcp-skills", "linked", "hosts.md"));
    setSkills("mcp-skills");
    const out = build();
    const gen = path.join(app, "gen", "srv");
    expect(
      readFileSync(path.join(gen, "mcp-skills/handle-return/references/checklist.md"), "utf8"),
    ).toBe("# Checklist\n");
    expect(existsSync(path.join(gen, "mcp-skills/handle-return/.env"))).toBe(false);
    expect(existsSync(path.join(gen, "mcp-skills/linked"))).toBe(false);
    expect(out).toMatch(/MCP skills folder mcp-skills: .*linked\/hosts\.md.*symlink/);
    // The deployed app serves what the source app serves.
    const served = async (root: string) => (await setUpSkills("mcp-skills", root)).uris;
    expect(await served(gen)).toEqual(await served(app));
    expect(await served(gen)).toEqual(["skill://handle-return/SKILL.md"]);
  }, 60_000);

  test("checks the folder as the app does: outside the app root, or through a symlink out, is not copied", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "cap-mcp-outside-"));
    try {
      mkdirSync(path.join(outside, "x"), { recursive: true });
      writeFileSync(path.join(outside, "x", "SKILL.md"), "---\nname: x\ndescription: x\n---\n");
      symlinkSync(outside, path.join(app, "linked-skills"));
      setSkills("linked-skills");
      expect(build()).toMatch(
        /MCP skills folder linked-skills is outside the app root; not copied/,
      );
      expect(existsSync(path.join(app, "gen", "srv", "linked-skills"))).toBe(false);
      setSkills("../escape");
      expect(build()).toMatch(/MCP skills folder \.\.\/escape .*; not copied/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  test("says when the skills folder cannot be copied (missing, or an absolute path)", () => {
    setSkills("missing-skills");
    expect(build()).toMatch(/MCP skills folder missing-skills does not exist; not copied/);
    setSkills(path.join(app, "mcp-skills"));
    expect(build()).toMatch(
      /MCP skills folder .*mcp-skills is an absolute path; the deployed app reads it there, so it is not copied/,
    );
  }, 60_000);
});
