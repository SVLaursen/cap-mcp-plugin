# Getting started

You have a CAP Node.js app and want an AI agent to work with its data over the
[Model Context Protocol](https://modelcontextprotocol.io). This takes about five minutes.

You need Node.js 22 or later, `@sap/cds` 10 or later and `@sap/cds-dk` (for `cds add` and
`cds watch`).

## 1. Install and expose a service

```bash
npm add @gavdi/cap-mcp
cds add mcp --service CatalogService
```

`cds add mcp` adds one line to `srv/mcp.cds` (it creates the file if needed and leaves your
service definition alone):

```cds
service CatalogService { entity Books { key ID : Integer; title : String; } } // yours, unchanged
annotate CatalogService with @mcp; // added
```

It also adds an `mcp` block with your app's name and version to `package.json`, and the plugin
to `dependencies` if it is not there yet. Existing values are never overwritten.

- `--service` takes a comma-separated list. It is required when the app has several services,
  so exposing a service is always your decision. Services imported with `cds import` are never
  offered.
- `--docs` also sets `cds.cdsc.docs`, so your `/** doc comments */` become tool descriptions.
  This adds them to the OData `$metadata` as well, which is why it is not the default.

You can also write the annotation yourself: `@mcp` on a service is all the plugin needs.

`@mcp` on a service gives the **read-only baseline**: a query tool and a get tool for each
entity, plus the service's functions. Nothing writes until you opt in.

## 2. Run it

```bash
cds watch
```

When CAP has served the app, the plugin logs what it serves and anything worth fixing:

```
[mcp] - serving 2 tools, 0 resources, 0 prompts at /mcp
```

Any line after it is a diagnostic (`CODE target: message`); see
[Troubleshooting](troubleshooting.md). The counts are for a user with every role; each caller
sees only what CAP lets them use.

## 3. Connect a client

The endpoint is `http://localhost:4004/mcp` (Streamable HTTP). It serves MCP 2026-07-28 clients
and older (2025-era) clients alike, without sessions.

Who the caller is depends on your CAP auth, exactly as for OData:

- With `dummy` auth, no credentials are needed.
- With `mocked` auth (CAP's default in development), send one of your
  mocked users as `Authorization: Basic <base64 of user:password>`. Without it, the caller is
  anonymous and sees only services without `@requires`.

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose the transport "Streamable HTTP", enter the URL above, and add the `Authorization` header
for a mocked user if you need one. The Inspector connects through its own local proxy by default.
If you switch it to a direct connection from the browser, add its origin to your config first:
`"cds": { "mcp": { "allowedOrigins": ["http://localhost:6274"] } }`. Any browser-based client
needs this; see [Authentication and production](production.md#browser-clients-and-dns-rebinding).

### Desktop and IDE clients that speak HTTP

Point them at the same URL. The tools a caller sees are the ones CAP would let _that user_ call
(`@requires`, `@restrict`), so log in as the user you want to test with.

### Clients that only speak stdio

Some desktop clients only start a local process and talk to it over stdio. The plugin has no
stdio command of its own: cds-dk does not let plugins add a `cds mcp` command, and stdio has no
way to authenticate a user. Keep `cds watch` running and let a bridge such as the community
package [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) forward stdio to the HTTP
endpoint:

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

The header logs the bridge in as a mocked user (here `alice:alice`, base64-encoded); leave it out
with `dummy` auth. CAP authenticates the bridge like any other HTTP client, so the client sees
exactly what that user may use.

## 4. Opt in to more

Everything beyond the baseline needs its own annotation. For example, an orders service where
agents may create and update orders, and cancel one after the user confirms:

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
- `@mcp` on an action exposes it (functions come with the service; actions never do).
- `@mcp.elicit` asks the user to confirm before the call runs.
- `@mcp.omit` keeps a field away from agents entirely.

The [annotation reference](annotations.md) lists every annotation. Then:

- [Resources, prompts, confirmation and completion](features.md)
- [MCP Apps](mcp-apps.md): interactive UI for a tool's result
- [Authentication and production](production.md): read this before you deploy

## Next

To see every feature at work, take [a tour of the demo app](demo-tour.md).
