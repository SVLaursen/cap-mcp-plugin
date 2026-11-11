# 0012 — MCP Apps without a runtime dependency on `@modelcontextprotocol/ext-apps`

Status: accepted · 2026-11-11 (M5)

## Context

`@mcp.ui: 'ui://…'` turns an operation's tool into an MCP App (issue #133): the tool's `_meta`
names a `ui://` resource, and the host reads that resource (HTML) and renders it next to the
tool's result. The backlog named `@modelcontextprotocol/ext-apps` for this.

ext-apps 2.0.4 is ESM-only, 1.7 MB, and peer-depends on zod ^4, react and react-dom and the SDK
client/core/server packages. Its server helpers do two things only:

- `registerAppTool` sets the tool's `_meta.ui.resourceUri` and the older `ui/resourceUri` key
  (`RESOURCE_URI_META_KEY`). The exposure registry already sets both (M2).
- `registerAppResource` calls `McpServer.registerResource` with the MIME type
  `text/html;profile=mcp-app` (`RESOURCE_MIME_TYPE`).

The rest of the package is the browser side (the app bridge, React hooks), which the app's HTML
uses, not the server.

## Decision

No runtime dependency. The adapter registers each `ui://` resource that one of the caller's
tools links to with `McpServer.registerResource` and the MIME type constant. ext-apps is a dev
dependency only: a contract test reads its server constants (in a child Node process, since it
is ESM-only) and asserts ours match, so a change in the extension shows up as a failing test.

Where the HTML comes from:

- **Default:** `ui://<host>/<path>` is the file `<cds.root>/app/mcp-apps/<path>`, read once
  when CAP has served the app. A missing file is logged as a warning, and the tool loses its UI
  link (it keeps working as a plain tool). Paths that leave `app/mcp-apps/` are refused.
- **Hook:** once the defaults are read, the plugin emits `cds.emit('mcp:apps', apps)`. App code
  adds or replaces a resource with `apps.register('ui://x/y.html', () => html)` (the content
  function is sync or async, called on every read, so the app decides about caching). The event
  is a plain emit: listeners register synchronously, before the startup checks run. No globals (ADR 0005): the app gets
  the registry as the event's argument.

A resource is served only to callers who see a tool that links to it, so an admin-only tool's
UI is not readable by others. A hook registration that no tool links to is logged and not
served (everything is opt-in, ADR 0004: the annotation is the opt-in, the hook supplies
content).

## Alternatives considered

- **Use ext-apps' server helpers at runtime.** Adds react, react-dom and zod 4 to every CAP app
  that installs the plugin, for one string constant.
- **A config map (`cds.env.mcp.apps: { 'ui://…': 'path' }`).** Config cannot produce HTML from
  code (templates, bundlers); the hook can, and the file default covers the simple case.

## Consequences

- The plugin follows the extension by hand: the compatibility test is the guard.
- Hosts that support MCP Apps render the UI; others ignore `_meta.ui` and show the tool result.
- `cds.on('mcp:apps')` is part of the user-facing contract (docs/annotations.md).
