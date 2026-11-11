# MCP Apps

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) let a tool come with an
interactive HTML UI that the host (the chat client) renders next to the tool's result. Hosts
that do not support MCP Apps ignore the UI and show the result as usual, so the tool keeps
working everywhere.

## Link a UI to an operation

```cds
service CatalogService {
  entity Books { key ID : Integer; title : String; }
  /** A rich card for one book. */
  @mcp.ui: 'ui://bookshop/book-card.html'
  function bookCard(book : Books:ID) returns Books;
}
annotate CatalogService with @mcp;
```

and put the HTML at `app/mcp-apps/book-card.html` in your app:

```
app/
  mcp-apps/
    book-card.html
```

`ui://<host>/<path>` is the file `app/mcp-apps/<path>` under your app's root. The `<host>` part
only names your app for the client; files are found by path. Paths that leave `app/mcp-apps/`
(also through symlinks) are refused.

What the plugin does:

- The tool's `_meta` links to the UI resource (`_meta.ui.resourceUri`, plus the older
  `_meta["ui/resourceUri"]` key), as the MCP Apps extension specifies.
- The file is read once, when CAP has served the app, and served as a resource with the MIME
  type `text/html;profile=mcp-app`. Restart (or let `cds watch` restart) after changing it.
- A UI resource is listed and readable only for callers who see a tool that links to it, so the
  UI of an admin-only operation stays with admins.
- A missing file is a startup warning, and the tool then has no UI link (it still works).

`@mcp.ui` belongs on an operation (function or action). The operation still has to be exposed:
functions are in the baseline of an `@mcp` service, actions need `@mcp`. In an `@mcp.compact`
service, `@mcp.ui` operations keep their own tool so hosts can show their UI.

## Writing the HTML

The page runs in the host's sandboxed iframe and talks to the host through the MCP Apps
protocol: it receives the tool's input and result, and can call tools of your server. The
[ext-apps repository](https://github.com/modelcontextprotocol/ext-apps) has the specification
and a browser SDK for this. Bundle what the page needs into the HTML (or serve it from code, as
below): the plugin serves exactly the content you give it.

A page that only shows the result needs no library. It sends `ui/initialize` to `window.parent`
over `postMessage`, answers the host's reply with `ui/notifications/initialized`, and then
receives `ui/notifications/tool-result`, whose `params` is the tool result. The plugin's results
carry `structuredContent: { value }` for operations, or `{ error: { code, message } }` with
`isError` when the call failed. The demo's
[`book-card.html`](../../demo/app/mcp-apps/book-card.html) does exactly this in about 30 lines
of script.

The plugin itself has no runtime dependency on `@modelcontextprotocol/ext-apps`.

## Supplying the HTML from code: `mcp:apps`

To build the HTML in code (a template, a bundler's output, a file somewhere else), or to replace
a file, register it when the plugin asks. The plugin emits `mcp:apps` once, when CAP has served
the app, with a registry as its argument:

```js
// server.js
const cds = require("@sap/cds");

cds.on("mcp:apps", (apps) => {
  apps.register(
    "ui://bookshop/stock-chart.html",
    () => '<!doctype html><html><body><div id="chart">Stock by genre</div></body></html>',
  );
});

module.exports = cds.server;
```

- Register inside the listener, synchronously: the plugin checks the registrations right after
  the event (an `async` listener that awaits first still registers, but after the startup
  warnings).
- The function you register runs on every read and may be async, so you decide about caching.
- A registration replaces the file for the same URI.
- A registration that no `@mcp.ui` links to is a warning and is not served: the annotation is the
  opt-in, the hook only supplies content.
- `register` throws for a URI that is not `ui://…` or content that is not a function.

## Limits

UI files are read for the `@mcp.ui` links of the app's base model. A `@mcp.ui` that exists only
in a tenant's extension has no content unless the hook registers it, and its tool then has no UI
link.
