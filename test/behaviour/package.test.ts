import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * M7 — the package as npm publishes it: only the runtime files, and it loads in an app,
 * including under the app's own Jest (cds.test), where JEST_WORKER_ID is set.
 */
const ROOT = path.join(__dirname, "..", "..");
let files: string[];
let app: string;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: ROOT },
  );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[];
  files = (packed[0]?.files ?? []).map((f) => f.path).sort();

  // An app with the plugin installed from exactly those files.
  app = mkdtempSync(path.join(tmpdir(), "cap-mcp-pkg-"));
  const installed = path.join(app, "node_modules", "@gavdi", "cap-mcp");
  for (const file of files) {
    mkdirSync(path.dirname(path.join(installed, file)), { recursive: true });
    cpSync(path.join(ROOT, file), path.join(installed, file));
  }
  for (const dep of ["@sap/cds", "@modelcontextprotocol/server", "@modelcontextprotocol/node"]) {
    mkdirSync(path.dirname(path.join(app, "node_modules", dep)), { recursive: true });
    symlinkSync(path.join(ROOT, "node_modules", dep), path.join(app, "node_modules", dep));
  }
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop" }));
}, 60_000);

afterAll(() => rmSync(app, { recursive: true, force: true }));

test("the package holds the runtime files, the README and the licence, nothing internal", () => {
  const top = [...new Set(files.map((f) => f.split("/")[0]))].sort();
  expect(top).toEqual(["LICENSE.md", "README.md", "cds-plugin.js", "lib", "package.json"]);
  expect(files).toContain("lib/index.js");
});

test("the installed plugin loads under the app's own Jest (JEST_WORKER_ID set)", () => {
  const res = spawnSync(
    process.execPath,
    ["-e", "require('@gavdi/cap-mcp/cds-plugin.js'); console.log('loaded')"],
    { cwd: app, env: { ...process.env, JEST_WORKER_ID: "1" }, encoding: "utf8" },
  );
  expect(res.stderr).toBe("");
  expect(res.stdout.trim()).toBe("loaded");
});
