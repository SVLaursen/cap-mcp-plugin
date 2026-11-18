# Architecture decision records

One file per decision: context, decision, consequences. Status is `accepted`, `proposed` (a
spike will settle it) or `superseded by NNNN`. To change a decision, write a new ADR that
supersedes the old one; don't edit history.

| #                                                      | Decision                                                               | Status                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------- |
| [0001](0001-stateless-mcp-2026-07-28.md)               | Target MCP 2026-07-28, stateless, on SDK v2                            | accepted                   |
| [0002](0002-mount-inside-cap-pipeline.md)              | Mount MCP inside CAP's middleware pipeline                             | accepted (refined by 0009) |
| [0003](0003-cap-does-the-work.md)                      | CAP does authorization, transactions, validation and search            | accepted                   |
| [0004](0004-everything-opt-in.md)                      | Everything is opt-in; `@mcp` on a service is a read-only baseline      | accepted                   |
| [0005](0005-no-globals.md)                             | No `global.cds`; dependencies are passed in                            | accepted                   |
| [0006](0006-tools-query-resources-are-records.md)      | Tools for querying and writes; resources are single records            | accepted                   |
| [0007](0007-test-against-real-cap.md)                  | Test against real CAP; never mock `@sap/cds`                           | accepted                   |
| [0008](0008-annotation-names.md)                       | Names: `@mcp.describe`, `@mcp.compact`, `@mcp.completion`              | accepted                   |
| [0009](0009-single-mcp-route-behind-cap-middleware.md) | One `/mcp` route behind CAP's middlewares, for all services            | accepted                   |
| [0010](0010-dual-era-stateless-sdk-handler.md)         | One stateless SDK handler for 2026-07-28 and 2025-era clients          | accepted                   |
| [0011](0011-doc-comments-are-the-apps-choice.md)       | Doc comments are the app's choice; the plugin does not set `cdsc.docs` | accepted                   |
| [0012](0012-mcp-apps-without-ext-apps-runtime.md)      | MCP Apps without a runtime dependency on `ext-apps`                    | accepted                   |
| [0013](0013-resources-from-code.md)                    | Resources from code: the `mcp:resources` event                         | accepted                   |
| [0014](0014-hints-from-code.md)                        | Hints from code: the `mcp:hints` event                                 | proposed                   |
| [0015](0015-filtered-read-notices.md)                  | Tell the agent when its reads are filtered                             | proposed                   |
