# Expose a service in 5 minutes

You have a CAP Node.js app and want an AI agent to read its data over MCP.

## 1. Install and annotate

```bash
npm add @gavdi/cap-mcp
cds add mcp --service CatalogService
```

`cds add mcp` writes `srv/mcp.cds`:

```cds
service CatalogService { entity Books { key ID : Integer; title : String; } }
annotate CatalogService with @mcp;
```

and adds an `mcp` block (your app's name and version) to `package.json`. With several services,
`--service` is required, so exposing a service is always your decision. Add `--docs` to use
your `/** doc comments */` as tool descriptions (this also adds them to OData `$metadata`).

`@mcp` on a service gives the **read-only baseline**: a query and a get tool for each entity,
plus its functions. Nothing writes until you ask for it.

## 2. Run it

```bash
cds watch
```

The `mcp` log line tells you what is served and anything worth fixing:

```
[mcp] - serving 2 tools, 0 resources, 0 prompts at /mcp
```

Any line after it is a diagnostic (`CODE target: message`); see
[Debug a missing tool](debugging.md).

## 3. Connect a client

The endpoint is `http://localhost:4004/mcp` (streamable HTTP). It serves MCP 2026-07-28 clients
and 2025-era clients alike, without sessions.

- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL
  above. With CAP's `mocked` auth, add the header `Authorization: Basic <base64 of user:password>`
  for one of your mocked users; with `dummy` auth you need no header.
- **Desktop and IDE clients** that speak HTTP take the same URL. The tools a caller sees are the
  ones CAP would let _that user_ call (`@requires`, `@restrict`), so log in as the user you
  want to test.

### Clients that only speak stdio

Some desktop clients only start local processes and talk to them over stdio. The plugin has no
stdio command of its own (cds-dk does not let plugins add a `cds mcp` command, and stdio has no
authentication). Run the app as usual and let a bridge such as the community package
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) forward stdio to the HTTP endpoint:

```json
{
  "mcpServers": {
    "bookshop": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:4004/mcp",
        "--header",
        "Authorization: Basic YWxpY2U6YWxpY2U="
      ]
    }
  }
}
```

Keep `cds watch` running while the client uses it. The header logs the bridge in as a mocked user
(here `alice:alice`, base64-encoded); leave it out with `dummy` auth. CAP authenticates the bridge
like any other HTTP client, so the client sees exactly what that user may use.

## 4. Opt in to more

Each of these needs its own annotation (docs/annotations.md has the full list):

```cds
service OrdersService {
  entity Orders { key ID : UUID; status : String; reason : String; }
    actions {
      @mcp @mcp.elicit: ['confirm'] action cancel();
    };
}
annotate OrdersService with @mcp;
annotate OrdersService.Orders with @mcp.wrap.modes: ['create', 'update'];
```

- `@mcp.wrap.modes` adds create, update or delete tools to an entity.
- `@mcp` on an action exposes it; `@mcp.elicit` asks the user to confirm first.
- `@mcp.resource`, `@mcp.prompts`, `@mcp.ui` (MCP Apps), `@mcp.describe` and `@mcp.compact` add
  the other MCP features.

Before going live, read [Lock it down for production](production.md).
