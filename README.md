# @gavdi/cap-mcp

> Pre-release version

Expose SAP CAP services to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io).

Annotate a service with `@mcp`, and agents can query it through MCP clients such as desktop
chat apps, IDEs and agent frameworks. The plugin is a thin, stateless adapter: CAP authenticates
every request, enforces `@requires` and `@restrict`, runs your handlers and owns the
transaction, exactly as it does for OData. Nothing is exposed unless you annotate it.

- One endpoint, `/mcp`, for all annotated services, serving MCP 2026-07-28 and 2025-era clients
- A read-only baseline from one annotation; writes, actions and every MCP feature are opt-in
- Tools with JSON Schema inputs and outputs, paging with totals, CAP search, structured errors
- Resources, prompts, MCP Apps UI, user confirmation (MRTR) and key completion
- XSUAA and IAS (also with X.509 credentials), `@sap/ams`, multitenant XSUAA, RFC 9728 metadata
- A startup report that tells you what is served and what in your model needs a look

## Install

```bash
npm add @gavdi/cap-mcp
```

Requires Node.js 22 or later, with `@sap/cds` 10 or later and `express` 5 as peer dependencies.
CAP loads the plugin automatically; there is no immediate integration code to write.

## Quickstart

Annotate a service, or let `cds add mcp --service CatalogService` write
`annotate CatalogService with @mcp;` to `srv/mcp.cds` for you:

```cds
/** Browse the bookshop catalog. */
@mcp                       // read-only baseline: query + get for entities, plus functions
service CatalogService {
  entity Books { key ID : Integer; title : String; stock : Integer; costPrice : Decimal; }

  @mcp                     // actions are opt-in
  action submitOrder(book : Integer, quantity : Integer);
}

annotate CatalogService.Books with { costPrice @mcp.omit; }; // never visible to agents
```

```bash
cds watch
```

```
[mcp] - serving 3 tools, 0 resources, 0 prompts at /mcp
```

The tools are `CatalogService_Books_query`, `CatalogService_Books_get` and
`CatalogService_submitOrder`, at `http://localhost:4004/mcp`.

**Connect a client.** Clients that speak Streamable HTTP (the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector), many desktop and IDE
clients) take the URL directly. With CAP's `mocked` auth, send a mocked user as
`Authorization: Basic …`; each user sees what CAP lets them use. Clients that only start local
processes over stdio use a bridge such as [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

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

[Getting started](docs/guide/getting-started.md) walks through it step by step.

## Everything is opt-in

| What                                | How                                                       |
| ----------------------------------- | --------------------------------------------------------- |
| Query and get tools for each entity | `@mcp` on the service (or on the entity)                  |
| Functions                           | `@mcp` on the service (or on the function)                |
| Actions                             | `@mcp` on the action                                      |
| Create, update, delete              | `@mcp.wrap.modes: ['create', 'update', 'delete']`         |
| Nested children in writes           | `@mcp.deepInsert` on the composition                      |
| Hide a field                        | `@mcp.omit` on the element                                |
| Single records as resources         | `@mcp.resource` on the entity                             |
| Prompts                             | `@mcp.prompts` on the service                             |
| MCP Apps UI                         | `@mcp.ui: 'ui://…'` on the operation                      |
| User confirmation before a call     | `@mcp.elicit` on the operation                            |
| Key completion                      | `@mcp.completion` on the key of an `@mcp.resource` entity |
| Model description tool              | `@mcp.describe` on the service                            |
| Compact generic tool set            | `@mcp.compact` on the service                             |

`@mcp: false` or `@cds.api.ignore` excludes an entity. No configuration switches a feature on.
See the [annotation reference](docs/guide/annotations.md).

## Security model

CAP does the security work; the plugin never re-implements it.

- **Authentication** is CAP's: `/mcp` runs behind CAP's own middlewares, so whatever
  authenticates OData authenticates MCP. With XSUAA, IAS or JWT, an unauthenticated request
  gets `401` with an [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) `resource_metadata`
  pointer naming your authorization server. In production, CAP's `restrict_all_services`
  applies to `/mcp` too.
- **Enforced by CAP on every call:** `@requires`, `@restrict` (including `where`), `@sap/ams`
  policies, input validation and your handlers. A user gets over MCP exactly what they get over
  OData. Each call runs in the caller's `cds.context` and one transaction, rolled back on error.
- **Hidden by the plugin, for the agent's sake:** `tools/list` leaves out tools CAP would always
  refuse for the caller. That is advertising, not enforcement.
- **Never exposed:** `@mcp.omit` fields, entities and operations you did not annotate, and
  actions without their own `@mcp`.
- **Browser requests (DNS rebinding):** a request with an `Origin` header gets `403` unless that
  origin is listed in `allowedOrigins`, even your app's own. Desktop clients and bridges send no
  `Origin` and are not affected; browser-based clients and web apps must be listed.

Read [Authentication and production](docs/guide/production.md) before you deploy.

## Configuration

Optional, in `cds.mcp` (`package.json` or `.cdsrc.json`, profiles work as usual). No key turns
a feature on.

| Key                  | Default                          | Meaning                                                                                             |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `path`               | `/mcp`                           | Endpoint path                                                                                       |
| `name`, `version`    | `@gavdi/cap-mcp` and its version | Server identity shown to clients; set them to tell apps apart                                       |
| `instructions`       | none                             | Instructions for agents: a string, or `{ "file": "mcp-instructions.md" }` relative to the app root  |
| `allowedOrigins`     | none                             | Browser origins that may call `/mcp` (browser-based clients, web apps); any other `Origin` gets 403 |
| `tenantHostPattern`  | none                             | Multitenant XSUAA: regular expression over the request host, first group = subscriber subdomain     |
| `limits.maxRows`     | `200`                            | Upper bound for `top` in query tools                                                                |
| `limits.defaultRows` | `25`                             | Page size when the agent gives none                                                                 |

```json
{
  "cds": {
    "mcp": {
      "name": "bookshop",
      "version": "1.0.0",
      "instructions": { "file": "mcp-instructions.md" },
      "limits": { "maxRows": 100 }
    }
  }
}
```

An unknown key or a value of the wrong shape is reported at startup and that key's default is
used. `cds build` copies the instructions file into the deployed app.

## Compatibility

|          |                                                                                               |
| -------- | --------------------------------------------------------------------------------------------- |
| MCP      | 2026-07-28 (stateless), and 2025-era clients (2025-11-25 back to 2024-11-05) without sessions |
| MCP Apps | The MCP Apps extension: `ui://` resources with `text/html;profile=mcp-app`                    |
| CAP      | `@sap/cds` 10 or later, Node.js runtime                                                       |
| Node.js  | 22 or later                                                                                   |
| Express  | 5                                                                                             |

## Migrating from v1

v2 reads v1 annotations through a shim and reports at startup what to change. Operation tools
are renamed, writes and the describe tool are no longer on by default, and CAP's own auth
replaces `auth: 'none'`. See [Migrating from v1](docs/guide/migrating-from-v1.md).

## Guides

<!-- TODO(repo): set package.json repository/homepage/bugs once the repository is decided, so
     these relative links also work on npmjs.com (or make them absolute). -->

- [Getting started](docs/guide/getting-started.md)
- [Annotation reference](docs/guide/annotations.md)
- [Resources, prompts, confirmation and completion](docs/guide/features.md)
- [MCP Apps](docs/guide/mcp-apps.md)
- [Authentication and production](docs/guide/production.md)
- [Troubleshooting](docs/guide/troubleshooting.md)
- [Migrating from v1](docs/guide/migrating-from-v1.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE.md)
