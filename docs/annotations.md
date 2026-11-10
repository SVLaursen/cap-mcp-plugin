# Annotation language (v2)

**Design rule: everything is opt-in.** Nothing appears over MCP unless an annotation asks for
it, and no config default switches a feature on. `@mcp` on a whole service gives a read-only
baseline; anything that writes, changes the agent's workflow or adds a new MCP primitive needs
its own annotation.

## Baseline and opt-ins

| Capability                          | Given by `@mcp` on the service                                 | Opt-in                                                      |
| ----------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Query and get tools for each entity | Yes, except entities marked `@mcp: false` or `@cds.api.ignore` | Not needed                                                  |
| Functions (bound and unbound)       | Yes, read-only by CDS definition                               | Not needed                                                  |
| Fields marked `@mcp.omit`           | Never exposed                                                  | Not applicable                                              |
| Actions                             | No                                                             | `@mcp` on the action                                        |
| Create, update, delete              | No                                                             | `@mcp.wrap.modes` on the entity                             |
| Deep insert                         | No                                                             | `@mcp.deepInsert` on the composition                        |
| Writes to draft-enabled entities    | No                                                             | `@mcp.wrap.modes` on the entity; runs through the draft API |
| Resources (single records by key)   | No                                                             | `@mcp.resource` on the entity                               |
| Prompts                             | No                                                             | `@mcp.prompts` on the service                               |
| MCP Apps UI (issue #133)            | No                                                             | `@mcp.ui` on the operation                                  |
| Confirmation and input requests     | No                                                             | `@mcp.elicit` on the operation                              |
| Value-help completion               | No                                                             | `@mcp.completion` on the element or parameter               |
| Model description tool              | No                                                             | `@mcp.describe` on the service                              |
| Compact generic tool mode           | No                                                             | `@mcp.compact` on the service                               |

Without `@mcp` on the service, `@mcp` on a single entity or operation exposes just that
definition (entity: query + get). Functions come with the service baseline only, not with
`@mcp` on their entity.

An entity whose records cannot be addressed (no keys, or a key is `@mcp.omit`) offers only
query, plus create if listed: get, update, delete and bound operations would hit no record or
several.

Entities CAP generates on its own are never part of the baseline: localized `.texts` entities
and `DraftAdministrativeData`. `@mcp: false` and `@cds.api.ignore` on an entity also remove its
bound operations.

## Reference

| Annotation         | On                         | Value                            | Meaning                                                                                                                                           |
| ------------------ | -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mcp`             | service, entity, operation | `true` / `false`                 | Expose (baseline) / exclude                                                                                                                       |
| `@mcp.name`        | any exposed definition     | String                           | Overrides the title shown to agents                                                                                                               |
| `@mcp.description` | any exposed definition     | String                           | Overrides the description                                                                                                                         |
| `@mcp.hint`        | element, parameter         | String                           | Overrides the element description                                                                                                                 |
| `@mcp.omit`        | element                    | `true`                           | Never selected, filtered, searched, ordered by, returned or described                                                                             |
| `@mcp.wrap.modes`  | entity                     | `['create','update','delete']`   | Adds write tools. `query` and `get` are always on for an exposed entity                                                                           |
| `@mcp.deepInsert`  | composition element        | `true`                           | Create/update accept nested children                                                                                                              |
| `@mcp.resource`    | entity                     | `true`                           | One record by key at `cap://<Service>/<Entity>/<key>`; tool results link to it                                                                    |
| `@mcp.prompts`     | service                    | array of prompt objects          | `{ name, title, description, template, role, inputs: [{ key, type }] }`                                                                           |
| `@mcp.ui`          | operation                  | `'ui://…'`                       | Registers the tool as an MCP App with that UI resource                                                                                            |
| `@mcp.elicit`      | operation                  | `['confirm']` or parameter names | Ask the user before running (MRTR `input_required`)                                                                                               |
| `@mcp.completion`  | element, parameter         | `true`                           | Offer `completion/complete` values (enum, value help, key list)                                                                                   |
| `@mcp.describe`    | service                    | `true`                           | Adds `<Service>_describe`, scoped to what this service exposes                                                                                    |
| `@mcp.compact`     | service                    | `true`                           | Generic tool set (`list_entities`, `describe_entity`, `query`, `get`, `create`, `update`, `delete`, `call_operation`) instead of per-entity tools |

Unknown `@mcp.*` keys produce an `UNKNOWN_ANNOTATION` diagnostic at startup.

## Diagnostics

The model reader reports these; the startup report (M6) prints them. Targets are written
`Def`, `Def:element`, `Entity.boundOperation` or `Operation:param`.

| Code                           | Level | When                                                                                                                             | Effect                                     |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `UNKNOWN_ANNOTATION`           | warn  | An `@mcp.*` key v2 does not know, anywhere in the model (incl. qualified `#x` keys)                                              | Ignored                                    |
| `V1_ANNOTATION`                | warn  | `@mcp.wrap.tools`, `@mcp.tool`, `@mcp.usePrimaryKey`, or `@mcp.resource: [ … ]`                                                  | Ignored (M6 shim maps)                     |
| `INVALID_ANNOTATION_VALUE`     | error | An unknown `@mcp.wrap.modes` value; `update`/`delete` on an entity without exposed keys; an `@mcp.ui` value that is not `ui://…` | That value is ignored                      |
| `BOUND_OPERATION_WITHOUT_KEYS` | error | An exposed bound operation on an entity without exposed keys (none, or one is `@mcp.omit`)                                       | The operation is not exposed               |
| `OMITTED_KEY`                  | warn  | `@mcp.omit` on a key of an exposed entity                                                                                        | Only query (and create) are offered for it |

## Names and descriptions

- Description: `@mcp.description` → `@description` → doc comment (`/** … */`) → `@title` → none.
- Title: `@mcp.name` → `@title` → definition name.
- Element description: `@mcp.hint` → `@description` → doc comment.
- Doc comments need `cds.env.cdsc.docs = true` in the app's own config. The plugin does not set
  it, because it also changes the app's OData `$metadata` (ADR 0011).

## Configuration (`cds.env.mcp`)

camelCase, read through `cds.env` only (profiles work as usual). No key turns a feature on.

| Key                  | Default             | Meaning                              |
| -------------------- | ------------------- | ------------------------------------ |
| `path`               | `/mcp`              | Endpoint path                        |
| `name`, `version`    | from `package.json` | Server identity in `server/discover` |
| `instructions`       | none                | String, or `{ file }`                |
| `limits.maxRows`     | `200`               | Upper bound for `top`                |
| `limits.defaultRows` | `25`                | Default page size                    |

Final key list is settled in M6; add keys only with a test and a row here.

## Migrating from v1

| v1                                                      | v2                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@mcp.resource: true` + `@mcp.wrap.tools: true`         | `@mcp` on the entity or service; query/get tools are the default         |
| `@mcp.resource: ['filter', 'top', …]`                   | Dropped. Use the query tool; `@mcp.resource` now means single records    |
| `@mcp.wrap.modes`                                       | Same name; `query`/`get` no longer need listing                          |
| `@mcp.tool: true` on an action/function                 | `@mcp` on the action; functions are baseline under `@mcp` on the service |
| `@mcp.name`, `@mcp.description` (required)              | Optional; fall back to CDS `@title`, `@description`, doc comments        |
| `@mcp.usePrimaryKey`                                    | Dropped (keys are always the entity keys)                                |
| config `wrap_entities_to_actions`                       | Dropped; use `@mcp` on the service                                       |
| config `wrap_entity_modes` (defaulted to create/update) | Dropped; writes need `@mcp.wrap.modes`                                   |
| config `enable_model_description` (default on)          | `@mcp.describe` on the service (default off)                             |
| config `auth: none`                                     | Use CAP's own auth config (`dummy` / `mocked` for local)                 |

The v1 shim (M6) reads v1 annotations, maps them, and reports `V1_ANNOTATION` /
`V1_DEFAULT_CHANGED` diagnostics so upgrades are a config change.
