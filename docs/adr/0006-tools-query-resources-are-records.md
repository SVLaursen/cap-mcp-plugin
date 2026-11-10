# 0006 — Tools for querying and writes; resources are single records

Status: accepted · 2026-11-10 (decided by the maintainer)

## Context

v1 offered two overlapping ways to expose an entity: resources with OData-syntax URI templates
(`odata://Service/name{?filter,orderby,…}`) and wrapped tools. In MCP, tools are
model-controlled (the agent calls them), while resources are application-controlled (the host
or user attaches them), and many clients never let the model read resources on its own.

## Decision

Querying and writing happen through tools with typed input and output schemas.
`@mcp.resource` exposes single records addressed by key (`cap://<Service>/<Entity>/<key>`), and
tool results include `resource_link` items to those records so a user can pin one as context.
The OData-syntax resource templates, the hand-written OData parser and the custom URI template
class are dropped.

## Consequences

- ~850 lines of v1 (`resources.ts`, `validation.ts`, `custom-resource-template.ts`) have no v2
  counterpart.
- v1 users of resource templates migrate to the query tool (documented in
  docs/annotations.md).
