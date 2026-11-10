# @gavdi/cap-mcp v2

Expose SAP CAP services to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io),
the CAP way: stateless, opt-in, and with CAP doing the authorization, transactions and validation.

> **Status: in development.** This repository holds the v2 rewrite. For the released plugin, see
> [gavdilabs/cap-mcp-plugin](https://github.com/gavdilabs/cap-mcp-plugin).

## What v2 will look like

```cds
/** Browse the bookshop catalog. */
@mcp                       // read-only baseline: query + get for entities, plus functions
service CatalogService {
  entity Books as projection on my.Books;

  @mcp                     // actions are opt-in
  action submitOrder(book : Books:ID @mcp.completion, quantity : Integer);
}

annotate CatalogService.Books with { costPrice @mcp.omit; };
```

Everything beyond the baseline is opt-in: writes (`@mcp.wrap.modes`), resources
(`@mcp.resource`), prompts, MCP Apps UI (`@mcp.ui`), confirmation (`@mcp.elicit`), completion,
the model description tool (`@mcp.describe`) and compact mode (`@mcp.compact`). See
[docs/annotations.md](docs/annotations.md).

## Developing

Requires Node 22+.

```bash
npm install
npm run check     # typecheck, lint, tests
npm run demo      # demo bookshop at http://localhost:4004 (users alice, bob, carol)
```

Development is test-first and milestone-driven: start with [CLAUDE.md](CLAUDE.md), then
[docs/backlog.md](docs/backlog.md).

## License

Apache-2.0
