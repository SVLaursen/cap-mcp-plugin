/**
 * CAP plugin entry point. CAP loads this file for any app that depends on @gavdi/cap-mcp.
 * Everything it does is in `plugin()` (src/index.ts), compiled to lib/.
 */
require("./lib/index.js").plugin(require("@sap/cds"));
