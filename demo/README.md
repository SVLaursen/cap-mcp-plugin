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

| Feature (docs/annotations.md)                             | Where                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline from `@mcp` on a service (query, get, functions) | `CatalogService`, `AdminService`, `OrdersService`                                                                                          |
| Action opt-in                                             | `CatalogService.submitOrder` (exposed), `CatalogService.restock` (not exposed)                                                             |
| `@mcp.omit`                                               | `Books.costPrice`, `Authors.email` in both Catalog and Admin                                                                               |
| `@mcp.name`, `@mcp.description`, `@mcp.hint`              | `CatalogService.stockByGenre` (title "Stock by genre"), `CatalogService.Authors` (description), `CatalogService.Books.status` (field hint) |
| `@mcp: false` / `@cds.api.ignore`                         | `AdminService.AuditNotes`, `AdminService.Genres.parent`                                                                                    |
| `@cds.search`                                             | `CatalogService.Books` (title, descr, authorName)                                                                                          |
| `@mcp.wrap.modes`                                         | `AdminService.Books` (create, update, delete), `OrdersService.Orders` (create, update, delete)                                             |
| Entity without keys (create, no read-back)                | `CatalogService.Feedback` (create only; seeded with one row from someone else)                                                             |
| Draft-enabled writes                                      | `OrdersService.Orders`                                                                                                                     |
| Draft activation handler (`before SAVE`)                  | `OrdersService.Orders`: numbers new orders (`orderNo`); `REASON_TOO_LONG` when `reason` exceeds 200 characters                             |
| `@mcp.deepInsert`                                         | `OrdersService.Orders.items`                                                                                                               |
| `@mcp.resource`                                           | `AdminService.Authors` (with key completion), `CatalogService.Genres` (without)                                                            |
| `@mcp.prompts`                                            | `AdminService` (`restock-plan`)                                                                                                            |
| `@mcp.ui` (MCP Apps, issue #133)                          | `CatalogService.bookCard` → `app/mcp-apps/book-card.html`                                                                                  |
| `cds.on('mcp:apps')` hook (UI from code)                  | `CatalogService.stockByGenre` → `ui://bookshop/stock-chart.html`, registered in `server.js`                                                |
| `@mcp.ui` on an admin-only operation (UI visibility)      | `AdminService.stockReport` → `app/mcp-apps/stock-report.html`                                                                              |
| `@mcp.elicit` (confirmation)                              | `OrdersService.Orders.cancel`                                                                                                              |
| `@mcp.completion`                                         | `AdminService.Authors:ID` (completes the `cap://AdminService/Authors/{key}` template)                                                      |
| `@mcp.describe`                                           | `CatalogService`                                                                                                                           |
| `@mcp.compact`                                            | `AdminService`                                                                                                                             |
| `@requires` on a service                                  | `AdminService` (admin), `OrdersService` (authenticated-user)                                                                               |
| `@restrict` with `where`                                  | `OrdersService.Orders` (own orders only; support reads all)                                                                                |
| Custom handler validation                                 | `AdminService` rejects negative prices                                                                                                     |
| Structured CAP errors                                     | `CatalogService.submitOrder` (`ORDER_EXCEEDS_STOCK`, target `quantity`)                                                                    |
| Translated error messages (`_i18n/messages*.properties`)  | `ORDER_EXCEEDS_STOCK` in English and German, with arguments; CAP's own `ASSERT_MANDATORY`                                                  |
| `cds.env.mcp.allowedOrigins`                              | `demo/package.json`: the MCP Inspector's browser origin (`http://localhost:6274`), for its direct connection mode                          |
| `cds.env.mcp.instructions` from a file                    | `demo/mcp-instructions.md`, set in `demo/package.json`; clients read it in `server/discover` / `initialize`                                |
| Failed commit surfaces as error                           | `AdminService` DELETE of Books ID 207 fails at commit                                                                                      |

When you add a feature to the plugin, add its target here first.
