# 0003 — CAP does authorization, transactions, validation and search

Status: accepted · 2026-11-10

## Context

v1 re-implemented `@requires`/`@restrict` checks, opened manual transactions (and swallowed
commit errors), built CQN from strings, parsed OData itself, and searched every String field.
Each re-implementation drifted from CAP and produced a bug or leak.

## Decision

The plugin translates; CAP decides. Every data access is `srv.run(cqn)` or `srv.send(...)` in
the request's `cds.context`. CQN is built as objects, never strings. Search uses
`SELECT.search`. The plugin never opens, commits or rolls back a transaction, and never decides
access. The registry may hide tools a user can never call (service/entity `@requires`), but
that is advertising, not enforcement.

## Consequences

- Custom handlers, `@restrict where`, `@readonly`, `@assert.*`, drafts, audit logging and AMS
  apply to MCP exactly as to OData.
- Tests assert "same as OData" instead of re-deriving rules.
- The plugin gets much smaller.
