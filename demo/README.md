# Demo bookshop

A small CAP app that gives every v2 feature an annotated target. Tests boot it with `cds.test`;
you can also run it with `npm run demo` from the repo root (OData at http://localhost:4004).

## Users (mocked auth)

| User  | Password | Roles   | Can see                                                   |
| ----- | -------- | ------- | --------------------------------------------------------- |
| alice | alice    | admin   | everything, including AdminService                        |
| bob   | bob      | none    | CatalogService, his own orders                            |
| carol | carol    | support | CatalogService, her own orders, and every order read-only |

## What each service exercises

| Feature (docs/annotations.md)                             | Where                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Baseline from `@mcp` on a service (query, get, functions) | `CatalogService`, `AdminService`, `OrdersService`                                      |
| Action opt-in                                             | `CatalogService.submitOrder` (exposed), `CatalogService.restock` (not exposed)         |
| `@mcp.omit`                                               | `Books.costPrice`, `Authors.email` in both Catalog and Admin                           |
| `@mcp: false` / `@cds.api.ignore`                         | `AdminService.AuditNotes`, `AdminService.Genres.parent`                                |
| `@cds.search`                                             | `CatalogService.Books` (title, descr, authorName)                                      |
| `@mcp.wrap.modes`                                         | `AdminService.Books` (create, update, delete), `OrdersService.Orders` (create, update) |
| Draft-enabled writes                                      | `OrdersService.Orders`                                                                 |
| `@mcp.deepInsert`                                         | `OrdersService.Orders.items`                                                           |
| `@mcp.resource`                                           | `AdminService.Authors`                                                                 |
| `@mcp.prompts`                                            | `AdminService` (`restock-plan`)                                                        |
| `@mcp.ui` (MCP Apps, issue #133)                          | `CatalogService.bookCard` → `app/mcp-apps/book-card.html`                              |
| `@mcp.elicit` (confirmation)                              | `OrdersService.Orders.cancel`                                                          |
| `@mcp.completion`                                         | `CatalogService.submitOrder(book)`                                                     |
| `@mcp.describe`                                           | `CatalogService`                                                                       |
| `@mcp.compact`                                            | `AdminService`                                                                         |
| `@requires` on a service                                  | `AdminService` (admin), `OrdersService` (authenticated-user)                           |
| `@restrict` with `where`                                  | `OrdersService.Orders` (own orders only; support reads all)                            |
| Custom handler validation                                 | `AdminService` rejects negative prices                                                 |
| Structured CAP errors                                     | `CatalogService.submitOrder` (`ORDER_EXCEEDS_STOCK`, target `quantity`)                |
| Failed commit surfaces as error                           | `AdminService` DELETE of Books ID 207 fails at commit                                  |

When you add a feature to the plugin, add its target here first.
