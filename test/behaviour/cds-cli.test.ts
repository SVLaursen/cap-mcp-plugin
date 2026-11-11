import { execFileSync } from "node:child_process";
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

/**
 * M6 — smoke tests: the real cds-dk CLI (`cds add mcp`, `cds build`) in a fresh app, with the
 * plugin installed.
 * The child process loads the plugin from lib/, so this builds it first.
 */
const ROOT = path.join(__dirname, "..", "..");
const CDS = path.join(ROOT, "node_modules", "@sap", "cds-dk", "bin", "cds.js");
let app: string;

/** Run the cds CLI in the app, outside Jest (so cds-plugin.js loads lib/). */
function cds(...args: string[]): string {
  const env = { ...process.env };
  delete env.JEST_WORKER_ID;
  return execFileSync(process.execPath, [CDS, ...args], { cwd: app, env, encoding: "utf8" });
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: ROOT },
  );
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
    "service CatalogService { entity Books { key ID: Integer; } }\nservice AdminService { entity Notes { key ID: Integer; } }\n",
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

test("running it again for another service adds to srv/mcp.cds instead of replacing it", () => {
  cds("add", "mcp", "--service", "AdminService");
  const file = readFileSync(path.join(app, "srv", "mcp.cds"), "utf8");
  expect(file.match(/annotate \w+ with @mcp;/g)).toEqual([
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
