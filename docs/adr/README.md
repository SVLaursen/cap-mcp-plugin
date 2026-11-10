# Architecture decision records

One file per decision: context, decision, consequences. Status is `accepted`, `proposed` (a
spike will settle it) or `superseded by NNNN`. To change a decision, write a new ADR that
supersedes the old one; don't edit history.

| #                                                 | Decision                                                               | Status              |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------- |
| [0001](0001-stateless-mcp-2026-07-28.md)          | Target MCP 2026-07-28, stateless, on SDK v2                            | accepted            |
| [0002](0002-mount-inside-cap-pipeline.md)         | Mount MCP inside CAP's middleware pipeline                             | proposed (M4 spike) |
| [0003](0003-cap-does-the-work.md)                 | CAP does authorization, transactions, validation and search            | accepted            |
| [0004](0004-everything-opt-in.md)                 | Everything is opt-in; `@mcp` on a service is a read-only baseline      | accepted            |
| [0005](0005-no-globals.md)                        | No `global.cds`; dependencies are passed in                            | accepted            |
| [0006](0006-tools-query-resources-are-records.md) | Tools for querying and writes; resources are single records            | accepted            |
| [0007](0007-test-against-real-cap.md)             | Test against real CAP; never mock `@sap/cds`                           | accepted            |
| [0008](0008-annotation-names.md)                  | Names: `@mcp.describe`, `@mcp.compact`, `@mcp.completion`              | accepted            |
| [0011](0011-doc-comments-are-the-apps-choice.md)  | Doc comments are the app's choice; the plugin does not set `cdsc.docs` | accepted            |
