const cds = require("@sap/cds");

// MCP Apps hook (docs/annotations.md, ADR 0012): supply a ui:// resource from code. Files under
// app/mcp-apps/ are the default; a registration here adds or replaces one.
cds.on("mcp:apps", (apps) => {
  apps.register(
    "ui://bookshop/stock-chart.html",
    () =>
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Stock</title></head>' +
      '<body><div id="chart">Stock by genre</div></body></html>',
  );
});

module.exports = cds.server;
