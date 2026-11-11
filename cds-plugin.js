/**
 * CAP plugin entry point. CAP loads this file for any app that depends on @gavdi/cap-mcp.
 *
 * Under this repository's own Jest the TypeScript sources are loaded directly (ts-jest
 * transforms them), so tests never run against a stale build. Everywhere else, including an
 * app's own Jest tests (the published package has no src/), the compiled output in lib/ is used.
 */
const { existsSync } = require("node:fs");
const path = require("node:path");
const cds = require("@sap/cds");

const sources = path.join(__dirname, "src", "index.ts");
const underOwnJest = !!process.env.JEST_WORKER_ID && existsSync(sources);
const impl = underOwnJest ? require(sources) : require("./lib/index.js");

impl.activate(cds);

// `cds add mcp`: cds-dk sets cds.cli before it loads plugins, and only it has cds.add.
if (cds.cli?.command === "add" && cds.add) {
  cds.add.register(
    "mcp",
    impl.mcpFacet(cds, { name: "@gavdi/cap-mcp", version: impl.packageVersion() }),
  );
}

// `cds build`: copy the instructions file into the deployed app (only when one is configured).
if (cds.cli?.command === "build" && cds.build?.register) {
  cds.build.register("mcp", impl.mcpBuildTask(cds));
}
