#!/usr/bin/env node
/**
 * Runs the official MCP conformance suite (@modelcontextprotocol/conformance) against the demo.
 *
 *   npm run build && npm run conformance
 *
 * Boots the demo with `cds-serve` on a free port, with CAP's `dummy` auth (the suite sends no
 * credentials) and its own origin in `allowedOrigins`, runs every active server scenario, and exits with the suite's exit code. Known
 * failures are listed with their reason in conformance-baseline.yml: the suite expects fixtures
 * of its reference server (tools such as `test_simple_text`, prompts, `test://` resources) and
 * features v2 does not offer (logging, subscriptions). A scenario that starts failing, or a
 * listed one that starts passing, fails the run.
 *
 * Talks only to localhost. Needs lib/ (`npm run build`), since outside Jest the plugin loads it.
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const { setTimeout: sleep } = require("node:timers/promises");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, server, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`demo exited with ${server.exitCode}`);
    const up = await new Promise((resolve) =>
      http.get(url, (res) => resolve(!!res.resume())).on("error", () => resolve(false)),
    );
    if (up) return;
    await sleep(250);
  }
  throw new Error(`demo did not start within ${timeoutMs} ms`);
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, [require.resolve("@sap/cds/bin/serve.js")], {
    cwd: path.join(root, "demo"),
    env: {
      ...process.env,
      PORT: String(port),
      CDS_REQUIRES_AUTH_KIND: "dummy",
      // The dns-rebinding scenario expects a browser on the server's own localhost origin to be
      // let in: list it, as an app does for a browser client (cds.mcp.allowedOrigins).
      CDS_CONFIG: JSON.stringify({ mcp: { allowedOrigins: [`http://localhost:${port}`] } }),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stop = () => server.exitCode === null && server.kill();
  process.on("exit", stop);

  try {
    await waitFor(`http://localhost:${port}/`, server);
    const suite = spawn(
      process.execPath,
      [
        require.resolve("@modelcontextprotocol/conformance/dist/index.js"),
        "server",
        "--url",
        `http://localhost:${port}/mcp`,
        "--expected-failures",
        path.join(root, "conformance-baseline.yml"),
        "--output-dir",
        path.join(root, "_out", "conformance"),
        ...process.argv.slice(2),
      ],
      { cwd: root, stdio: "inherit" },
    );
    const code = await new Promise((resolve) => suite.on("exit", (c) => resolve(c ?? 1)));
    process.exitCode = code;
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
