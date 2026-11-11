const cds = require("@sap/cds");

// MCP Apps hook (docs/annotations.md, ADR 0012): supply a ui:// resource from code. Files under
// app/mcp-apps/ are the default; a registration here adds or replaces one.
cds.on("mcp:apps", (apps) => {
  apps.register("ui://bookshop/stock-chart.html", stockChart);
});

/**
 * The UI of CatalogService.stockByGenre: the genre (from the tool's arguments) and its stock as a
 * bar. Built in code to show the hook; a real app might render a template or read a bundle here.
 * The bridge is the same as in app/mcp-apps/book-card.html.
 */
function stockChart() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Stock by genre</title>
    <style>
      body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; }
      #bar { height: 16px; background: #3a7bd5; border-radius: 4px; width: 0; max-width: 100%; }
      #error { color: #b00020; }
      #error:empty { display: none; }
    </style>
  </head>
  <body>
    <div id="chart">
      <h1 style="font-size: 18px; margin: 0 0 8px">Stock by genre</h1>
      <p id="error"></p>
      <p>Genre <span id="genre"></span>: <span id="stock"></span> books in stock</p>
      <div id="bar"></div>
    </div>
    <script>
      const FULL_BAR = 100; // books in stock for a full-width bar
      const set = (id, text) => (document.getElementById(id).textContent = text ?? "");
      function input(args) {
        set("genre", args?.genre);
      }
      function render(result) {
        const content = result.structuredContent ?? {};
        if (result.isError) return set("error", content.error?.message ?? result.content?.[0]?.text);
        set("stock", content.value);
        document.getElementById("bar").style.width = Math.min(100, (100 * content.value) / FULL_BAR) + "%";
      }

      // The MCP Apps bridge (ext-apps protocol 2026-01-26): JSON-RPC over postMessage.
      (() => {
        const host = window.parent;
        const send = (message) => host.postMessage({ jsonrpc: "2.0", ...message }, "*");
        const size = () =>
          send({ method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } });
        window.addEventListener("message", ({ source, data }) => {
          if (source !== host || data?.jsonrpc !== "2.0") return;
          if (data.id === 1 && !data.method) send({ method: "ui/notifications/initialized" });
          if (data.method === "ui/notifications/tool-input") input(data.params?.arguments);
          if (data.method === "ui/notifications/tool-result") {
            render(data.params);
            size();
          }
        });
        send({
          id: 1,
          method: "ui/initialize",
          params: {
            appInfo: { name: "bookshop-stock-chart", version: "1.0.0" },
            appCapabilities: {},
            protocolVersion: "2026-01-26",
          },
        });
      })();
    </script>
  </body>
</html>
`;
}

module.exports = cds.server;
