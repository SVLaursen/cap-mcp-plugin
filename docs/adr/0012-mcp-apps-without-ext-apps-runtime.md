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
  link (it keeps working as a plain tool). Paths that leave `app/mcp-apps/` are refused. Symlinks are followed and must stay inside it too. The `<host>` part names the app
  for the client only; files are found by path.
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
- Files are read for the `@mcp.ui` links of the app's base model. A link that exists only in a
  tenant's extended model has no file content unless the hook registers it; the tool then has
  no UI link. Revisit if extensions ask for MCP Apps.

## Addendum: what the extension asks of a server (2026-11-25, 2.0 RC2)

Read: `specification/2026-01-26/apps.mdx` in modelcontextprotocol/ext-apps (status "Stable
(2026-01-26)"), against ext-apps 2.0.4 (`EXTENSION_ID = "io.modelcontextprotocol/ui"`). The
decision above stands; this records what the specification says, so the next change starts
from it.

- **Declaring the extension.** Only clients declare it: hosts put
  `extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }` in
  their capabilities. The specification defines no server-side declaration, no shape for one,
  and no MUST, SHOULD or MAY for it. So `server/discover` and `initialize` carry no
  `extensions` entry for MCP Apps, and RC2 adds none (no code). The protocol's extensions
  overview (modelcontextprotocol.io/extensions) shows a server declaring
  `"io.modelcontextprotocol/ui": {}` in a `server/discover` example, with no MUST, SHOULD or MAY
  behind it; the extension's own pages say nothing about it. If a later revision of the
  extension asks servers to declare it, advertise it only to callers with at least one UI tool,
  as for every other capability (ADR 0004).
- **Checking the client.** "Servers SHOULD check client capabilities before registering
  UI-enabled tools", and MAY register different tool variants per host. v2 does not: every
  caller who sees a UI tool gets its `_meta.ui` link, whatever the client declared. That is the
  choice the M5 review left as accepted here (UI links for clients without MCP Apps support):
  the specification's own fallback is that a host without MCP Apps treats the tool as a plain
  tool, and v2's tools always return a meaningful `content` array ("Tools MUST return
  meaningful content array even when UI is available"). Revisit if a host misbehaves on
  `_meta.ui`.
- **Resources.** `ui://` URIs, contents as `text` (HTML5) with MIME type
  `text/html;profile=mcp-app` (MUST for contents; the listing interface says SHOULD). Listed
  resources need a human-readable `name`; the extension defines no `title` (MCP's own
  `Resource` has one). Servers MAY leave UI-only resources out of `resources/list`; v2 lists
  them for callers whose tools link to them. `_meta.ui` on contents (`csp`, `permissions`,
  `domain`, `prefersBorder`) is optional; v2 sends none, so hosts apply their restrictive
  default CSP.
- **Tools.** `_meta.ui = { resourceUri, visibility? }`, visibility defaulting to
  `["model", "app"]`; v2 sends `resourceUri` only. The flat `_meta["ui/resourceUri"]` is
  deprecated and "will be removed before GA"; v2 still sends it beside `ui.resourceUri`, as
  ext-apps' `registerAppTool` does (the contract test pins both). Drop it when ext-apps does.
