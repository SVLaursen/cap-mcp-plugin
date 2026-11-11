# A tour of the demo app

The repository's `demo/` app is a small bookshop where every feature of the plugin has a working
target. This tour walks through them with [MCP Inspector](https://github.com/modelcontextprotocol/inspector).
The full list of targets is in [`demo/README.md`](../../demo/README.md).

## Start it

From the repository root:

```bash
npm run demo
```

The startup report ends with the line `[mcp] - serving 28 tools, 2 resources, 1 prompt at /mcp`.
That is everything the demo exposes; each caller sees only the part CAP lets them use.

In a second terminal, start the Inspector:

```bash
npm run inspect
```

Choose the transport "Streamable HTTP", enter `http://localhost:4004/mcp`, and add an
`Authorization` header for one of the demo's mocked users:

| User  | Roles   | Header                   |
| ----- | ------- | ------------------------ |
| alice | admin   | `Basic YWxpY2U6YWxpY2U=` |
| bob   | none    | `Basic Ym9iOmJvYg==`     |
| carol | support | `Basic Y2Fyb2w6Y2Fyb2w=` |

Without a header you are anonymous (the demo runs with mocked auth in development; in production
`/mcp` requires a login, see [Authentication and production](production.md)).

## 1. Each user sees what CAP lets them use

List the tools as each user:

- **anonymous**: 12 tools, all from `CatalogService`.
- **bob** and **carol**: 20 tools: the catalog plus `OrdersService`, which requires an
  authenticated user.
- **alice**: 28 tools: everything above plus `AdminService` (`@requires: 'admin'`).

Nothing is hidden by the plugin's own rules; it hides what CAP would always refuse
(`@requires`, role grants of `@restrict`), and CAP still checks every call.

## 2. The read-only baseline

`CatalogService` only has `@mcp` on the service, so its entities get query and get tools and its
functions are tools too. Try `CatalogService_Books_query`:

- The rows never contain `costPrice` (`@mcp.omit` in `catalog-service.cds`).
- `q: "Poe"` searches the fields listed in `@cds.search` and finds two books.
- `where`, `orderby`, `select`, `top` and `cursor` page through results; field names are checked
  against what the entity exposes.

`CatalogService_describe` (`@mcp.describe`) describes the service: its entities, fields and
operations, and nothing from other services.

## 3. What agents read about each tool

- `CatalogService_stockByGenre` is titled **Stock by genre** (`@mcp.name`).
- `CatalogService_Authors_query` carries the description from `@mcp.description`: _Authors of
  the books in the catalog. Email addresses are never shared._
- In the Books tools, the `status` field is described as _available or discontinued; only
  available books can be ordered_ (`@mcp.hint`).
- Everything else falls back to doc comments (`/** … */`), which the demo keeps with
  `cdsc.docs: true` in `demo/package.json`.

The server's instructions come from `demo/mcp-instructions.md` (`mcp.instructions` in
`demo/package.json`); clients receive them when they connect.

## 4. Actions and errors from your handlers

`CatalogService_submitOrder` is an action, exposed because it has its own `@mcp`
(`restock`, which has none, is not listed). Order `{ "book": 201, "quantity": 2 }` and the
demo's handler answers with the remaining stock. Order 5000 and you get the handler's error as a
tool error: code `ORDER_EXCEEDS_STOCK`, target `quantity`, message _Only 12 in stock; 5000
ordered_, the same text OData returns. Send `Accept-Language: de` to get it in German.

## 5. Row-level security is CAP's

As bob, `OrdersService_Orders_query` returns one order (`ORD-1001`); as carol (support) it
returns two. That is `@restrict … where: 'createdBy = $user'` in `orders-service.cds`, applied
by CAP exactly as over OData.

## 6. Writes, drafts and confirmation

- `OrdersService_Orders_create` with `{ "reason": "gift", "items": [{ "book_ID": 251, "quantity": 1 }] }`
  creates an active order with its items in one call (`@mcp.deepInsert` on `items`). Orders are
  draft-enabled, so the plugin runs CAP's draft flow; the demo's `before SAVE` handler numbers
  the order.
- `OrdersService_Orders_cancel` has `@mcp.elicit: ['confirm']`. A client that can show forms
  asks you to confirm before it runs; a client that cannot gets `CONFIRMATION_REQUIRED` and
  nothing changes.
- `CatalogService_Feedback_create` writes to an entity without keys: you get back what you wrote
  (there is no way to read one record of it).

## 7. The admin service: compact tools, resources, prompts

Connect as alice. `AdminService` has `@mcp.compact`, so instead of per-entity tools it offers
`AdminService_list_entities`, `_describe_entity`, `_query`, `_get`, `_create`, `_update` and
`_delete`, each taking the entity as an argument.

- Update a book with a negative price: the demo's handler rejects it (`PRICE_NEGATIVE`).
- Delete book 207: the handler lets it through but the commit fails, and you get an error; the
  book is still there.
- Resources: `cap://AdminService/Authors/{key}` and `cap://CatalogService/Genres/{key}` are
  record templates (`@mcp.resource`). Authors' key completes as you type
  (`@mcp.completion`).
- Prompts: `restock-plan` (`@mcp.prompts`) takes a `threshold`.

## 8. MCP Apps

Hosts that support MCP Apps render a UI for three operations:

- `CatalogService_bookCard`: `app/mcp-apps/book-card.html` (`@mcp.ui`).
- `CatalogService_stockByGenre`: its UI is registered from code in `demo/server.js`
  (`cds.on('mcp:apps')`).
- `AdminService_stockReport`: an admin-only UI; only alice can list or read it.

Each page renders the tool result the host sends it: the book card shows the book (or the
handler's error, e.g. for book 999), the chart the genre's stock as a bar, the report one line
per book under the threshold. The UI resources are listed under `resources/list`. See
[MCP Apps](mcp-apps.md).

## Not in the running demo

Two features need more than a local app with mocked users. Their tests show them end to end:

- **Multitenant XSUAA** (`mcp.tenantHostPattern`): the auth metadata names each subscriber's
  authorization server. `npx jest test/auth/xsuaa-multitenant.test.ts` runs it against the demo
  with a local token issuer and real token validation. Configuration is in
  [Authentication and production](production.md).
- **v1 annotations**: the demo uses v2 annotations only. `test/contract/v1-compatibility.test.ts`
  reads v1's own demo annotations through the compatibility shim and checks the tools they
  produce; [Migrating from v1](migrating-from-v1.md) explains the mapping.
