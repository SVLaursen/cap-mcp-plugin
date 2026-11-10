# 0004 — Everything is opt-in; `@mcp` on a service is a read-only baseline

Status: accepted · 2026-11-10 (decided by the maintainer)

## Context

Developers want to expose a service in one line, but MCP puts an autonomous agent in front of
their data. v1 had defaults that switched features on (`enable_model_description` on;
`wrap_entity_modes` included create and update).

## Decision

Nothing appears over MCP unless an annotation asks for it, and no config default switches a
feature on. `@mcp` on a service gives query + get for its entities and all its functions.
Actions, writes, deep insert, draft writes, resources, prompts, MCP Apps UI, elicitation,
completion, the describe tool and compact mode each need their own annotation
(docs/annotations.md).

## Consequences

- Upgrading from v1 can remove capabilities apps relied on by default. The v1 shim reports
  `V1_DEFAULT_CHANGED` for each.
- Every feature needs a test proving it is absent without its annotation.
