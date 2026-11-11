/**
 * CAP plugin entry point. CAP loads this file for any app that depends on @gavdi/cap-mcp.
 *
 * Under Jest the TypeScript sources are loaded directly (ts-jest transforms them), so tests
 * never run against a stale build. Everywhere else the compiled output in lib/ is used.
 */
const cds = require("@sap/cds");

const underJest = !!process.env.JEST_WORKER_ID;
const impl = underJest ? require("./src/index.ts") : require("./lib/index.js");

impl.activate(cds);

// `cds add mcp`: cds-dk sets cds.cli before it loads plugins, and only it has cds.add.
if (cds.cli?.command === "add" && cds.add) {
  cds.add.register(
    "mcp",
    impl.mcpFacet(cds, { name: "@gavdi/cap-mcp", version: impl.packageVersion() }),
  );
}
