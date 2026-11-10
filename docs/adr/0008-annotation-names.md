# 0008 — Annotation names for new opt-ins

Status: accepted · 2026-11-10 (decided by the maintainer)

## Decision

| Feature                     | Annotation        | On                   |
| --------------------------- | ----------------- | -------------------- |
| Model description tool      | `@mcp.describe`   | service              |
| Compact generic tool mode   | `@mcp.compact`    | service              |
| Argument / value completion | `@mcp.completion` | element or parameter |

`@mcp.help` was considered for the description tool and rejected: it reads like "help text for
this tool", which `@mcp.description` and `@mcp.hint` already cover.
