# Migrating from v1

v2 is a rewrite. It speaks MCP 2026-07-28 without sessions, lets CAP do authorization and
transactions, and exposes nothing you did not annotate. Most v1 apps keep working after the
upgrade, because v2 reads v1 annotations through a shim and says what to change at startup.

## What changes for you

- **Everything is opt-in.** v1 switched features on by default (writes from
  `wrap_entity_modes`, the `cap_describe_model` tool). v2 does not: `@mcp` on a service gives
  read-only tools, and everything else needs its own annotation.
- **CAP's own auth applies.** `/mcp` runs behind CAP's middlewares; there is no `auth: 'none'`
  and no OAuth proxy. Use `dummy` or `mocked` auth locally, XSUAA or IAS in production. The
  plugin serves RFC 9728 metadata instead of v1's fake dynamic client registration.
- **Operation tools are renamed** to `<Service>_<operation>` (bound:
  `<Service>_<Entity>_<operation>`). v1's `@mcp.name` becomes the tool's title. Entity tool
  names (`<Service>_<Entity>_<mode>`) did not change.
- **Resources are single records.** v1's OData-syntax resource templates are gone; query tools
  cover that. `@mcp.resource: true` now means "one record by key at `cap://…`".
- **Confirmation uses MRTR.** `@mcp.elicit` asks the user through MCP 2026-07-28's multi
  round-trip requests; 2025-era clients get an error instead of an unconfirmed call.
- **Config is camelCase** and read through `cds.env` only. v1 keys are reported and ignored.

## Upgrade

```bash
npm add @gavdi/cap-mcp@^2
cds watch
```

Read the startup report. Every `V1_ANNOTATION` and `V1_DEFAULT_CHANGED` line names what to write
instead. Then work through this checklist:

- [ ] Add `@mcp.wrap.modes` where the report says create or update came from v1's default.
- [ ] Add `@mcp.describe` to a service if agents relied on `cap_describe_model`.
- [ ] Update agent prompts or client configs that call operation tools by their v1 name.
- [ ] Replace v1 annotations with v2 ones (the report says where), then remove v1 config keys.
- [ ] Set CAP's auth for local use (`dummy` or `mocked`) if the app used `auth: 'none'`.
- [ ] Clients that only speak stdio: run `cds watch` and a bridge such as `mcp-remote`
      ([Getting started](getting-started.md#clients-that-only-speak-stdio)).

## Annotations

| v1                                                       | v2                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@mcp.wrap.tools: true` on an entity                     | `@mcp` on the entity (query and get), plus `@mcp.wrap.modes` for writes                                                              |
| `@mcp.wrap.modes`                                        | Same; `query` and `get` no longer need listing                                                                                       |
| `@mcp.tool: true` on an action or function               | `@mcp` on it; functions need nothing under `@mcp` on the service                                                                     |
| `@mcp.resource: ['filter', 'top', …]` on an entity       | The shim gives query and get tools (never writes). Write `@mcp` on the entity                                                        |
| `@mcp.resource: true`                                    | Same name, new meaning: one record by key. It needs the entity exposed (`@mcp`)                                                      |
| `@mcp.elicit: ['input', …]`                              | Parameter names to ask for: `@mcp.elicit: ['quantity']`; the shim maps `'input'` to all parameters (`'confirm'` when there are none) |
| `@mcp.name`, `@mcp.description` (required)               | Optional; they fall back to `@title`, `@description` and doc comments. `@mcp.name` is the title, never the tool name                 |
| `@mcp.hint`, `@mcp.omit`, `@mcp.prompts`                 | Same                                                                                                                                 |
| `@mcp.usePrimaryKey`, `@mcp.wrap.name`, `@mcp.wrap.hint` | Dropped: keys are always the entity's keys, names are generated, use `@mcp.description`                                              |

The shim only reads v1 keys where v1 did (`@mcp.tool` on operations, `@mcp.wrap.tools` and the
list form of `@mcp.resource` on entities of a service). Elsewhere they are reported and expose
nothing.

## Configuration

| v1 (`cds.mcp`)                                           | v2                                                    |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `name`, `version`, `instructions` (string or `{ file }`) | Same                                                  |
| `wrap_entities_to_actions`                               | Ignored; use `@mcp` on the service or entity          |
| `wrap_entity_modes` (defaulted to create/update)         | Ignored; writes need `@mcp.wrap.modes`                |
| `enable_model_description` (default on)                  | Ignored; `@mcp.describe` on the service (default off) |
| `auth: 'none'`                                           | Ignored; CAP's own auth applies                       |
| `capabilities.*.listChanged`                             | Ignored; lists never change while the server runs     |
| `tool_call_timeout` (v1.9, default 10 s)                 | Ignored; no timeout, a call runs until CAP finishes   |
| The block as a JSON string                               | Not read (`INVALID_CONFIG`); write it as an object    |

## A worked example

[docs/v1-compatibility.md](../v1-compatibility.md) walks through v1's own demo app tool by tool:
what each v1 tool is called in v2, and what the shim reports.
