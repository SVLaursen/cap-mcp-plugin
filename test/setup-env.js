// Tests deliberately trigger CAP errors (403, 409, …). Keep the expected ones out of the output.
process.env.CDS_LOG_LEVELS_ODATA ??= "error";
process.env.CDS_LOG_LEVELS_CDS ??= "warn";

// Load the plugin from src/ (test/cds-plugin-src.js), not lib/: CAP merges CDS_CONFIG over the
// plugins it found in package.json. Child processes that must use lib/ drop CDS_CONFIG.
const path = require("node:path");
const config = JSON.parse(process.env.CDS_CONFIG || "{}");
config.plugins = {
  ...config.plugins,
  "@gavdi/cap-mcp": { impl: path.join(__dirname, "cds-plugin-src.js") },
};
process.env.CDS_CONFIG = JSON.stringify(config);
