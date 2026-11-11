import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The package as npm publishes it: only the runtime files, and an app with exactly those files
 * installed serves MCP, also under the app's own Jest (cds.test). lib/ is built once for the
 * behaviour tests (test/build-lib.js).
 */
const ROOT = path.join(__dirname, "..", "..");
let files: string[];
let app: string;
let server: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(() => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[];
  files = (packed[0]?.files ?? []).map((f) => f.path).sort();

  // An app with the plugin installed from exactly those files, and only its declared
  // dependencies (and CAP's) next to it.
  app = mkdtempSync(path.join(tmpdir(), "cap-mcp-pkg-"));
  const installed = path.join(app, "node_modules", "@gavdi", "cap-mcp");
  for (const file of files) {
    mkdirSync(path.dirname(path.join(installed, file)), { recursive: true });
    cpSync(path.join(ROOT, file), path.join(installed, file));
  }
  const own = JSON.parse(
    execFileSync(npm, ["pkg", "get", "dependencies"], { cwd: ROOT, encoding: "utf8" }),
  ) as Record<string, string>;
  for (const dep of ["@sap/cds", "express", ...Object.keys(own)]) {
    mkdirSync(path.dirname(path.join(app, "node_modules", dep)), { recursive: true });
    symlinkSync(path.join(ROOT, "node_modules", dep), path.join(app, "node_modules", dep));
  }
  writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({
      name: "shop",
      dependencies: { "@sap/cds": "*", "@gavdi/cap-mcp": "*" },
      cds: { requires: { auth: "dummy" } },
    }),
  );
  mkdirSync(path.join(app, "srv"));
  writeFileSync(
    path.join(app, "srv", "cat.cds"),
    "@mcp service CatalogService { entity Books { key ID : Integer; title : String; } }\n",
  );
}, 60_000);

afterAll(() => {
  server?.kill();
  rmSync(app, { recursive: true, force: true });
});

test("the package holds the runtime files, the README and the licence, nothing internal", () => {
  const top = [...new Set(files.map((f) => f.split("/")[0]))].sort();
  expect(top).toEqual(["LICENSE.md", "README.md", "cds-plugin.js", "lib", "package.json"]);
  expect(files).toContain("lib/index.js");
  // Source maps would point at src/, which is not published.
  expect(files.filter((f) => f.endsWith(".map"))).toEqual([]);
});

test("an app with the installed package serves tools, also under its own Jest", async () => {
  const port = await freePort();
  // As under the app's own Jest (JEST_WORKER_ID set), without this repository's test wiring.
  const { CDS_CONFIG: _ours, ...env } = process.env;
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/@sap/cds/bin/serve.js")], {
    cwd: app,
    env: { ...env, PORT: String(port), JEST_WORKER_ID: "1", NODE_ENV: "development" },
  });
  let log = "";
  server.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  server.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  for (let i = 0; i < 100 && !/server listening/.test(log) && server.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(log).toMatch(/\[mcp\] - serving 2 tools, 0 resources, 0 prompts at \/mcp/);

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).toContain('"name":"CatalogService_Books_query"');
}, 30_000);
