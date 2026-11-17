const cds = require("@sap/cds");

// MCP Apps hook (docs/annotations.md, ADR 0012): supply a ui:// resource from code. Files under
// app/mcp-apps/ are the default; a registration here adds or replaces one.
cds.on("mcp:apps", (apps) => {
  apps.register("ui://bookshop/stock-chart.html", stockChart);
});

// Resources from code (docs/annotations.md, ADR 0013): documents for agents, registered by app
// code or another plugin. A few fixed resources for entry points, a template for many.
cds.on("mcp:resources", (resources) => {
  resources.register({
    uri: "notes://bookshop/returns-policy.md",
    name: "returns-policy",
    title: "Returns policy",
    description: "How customers return books",
    mimeType: "text/markdown",
    read: () => "# Returns policy\n\nBooks can be returned within 30 days, unread.\n",
  });
  resources.register({
    uri: "notes://bookshop/stock-policy.md",
    name: "stock-policy",
    title: "Stock policy",
    description: "When to restock (admins only)",
    mimeType: "text/markdown",
    read: ({ locale }) => `# Stock policy (${locale ?? "no locale"})\n\nRestock below 10 copies.\n`,
    visible: ({ user }) => user.is("admin"),
  });
  resources.register({
    uri: "notes://bookshop/missing.md",
    name: "missing",
    mimeType: "text/markdown",
    read: () => {
      throw Object.assign(new Error("This note was deleted"), { status: 404 });
    },
  });
  resources.registerTemplate({
    uriTemplate: "notes://bookshop/topics/{+path}",
    name: "bookshop-topics",
    title: "Bookshop topics",
    description: "Short notes on shop topics, by path",
    mimeType: "text/markdown",
    read: ({ params }) => {
      const text = TOPICS[params.path];
      if (text === undefined) throw Object.assign(new Error("No such topic"), { status: 404 });
      return text;
    },
    complete: (_ctx, param, value) =>
      param === "path" ? Object.keys(TOPICS).filter((p) => p.startsWith(value)) : [],
  });
});

// Hints from code (docs/annotations.md, ADR 0014): say where the notes above apply, in the server
// instructions and on the tool they concern. Only for shop staff (support, admin): what bob
// gets is unchanged.
cds.on("mcp:hints", (hints) => {
  const staff = (user) => user.is("support") || user.is("admin");
  hints.addInstructions({
    id: "bookshop-policies",
    text: ({ user }) =>
      staff(user)
        ? "Shop policies are MCP resources. Read notes://bookshop/returns-policy.md before you answer a question about returns or cancellations."
        : undefined,
  });
  hints.addToolNotes({
    id: "bookshop-policies",
    note: ({ definition }, { user }) =>
      staff(user) && definition === "OrdersService.Orders.cancel"
        ? "A cancelled order that was delivered is a return: read notes://bookshop/returns-policy.md first."
        : undefined,
  });
});

/** The notes behind notes://bookshop/topics/{+path}; a real plugin would read files. */
const TOPICS = {
  "shipping.md": "# Shipping\n\nOrders ship within two working days.\n",
  "gifts/wrapping.md": "# Gift wrapping\n\nAny book can be gift-wrapped for free.\n",
};

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
