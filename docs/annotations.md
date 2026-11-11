# Annotation language (v2)

**Design rule: everything is opt-in.** Nothing appears over MCP unless an annotation asks for
it, and no config default switches a feature on. `@mcp` on a whole service gives a read-only
baseline; anything that writes, changes the agent's workflow or adds a new MCP primitive needs
its own annotation.

## Baseline and opt-ins

| Capability                          | Given by `@mcp` on the service                                 | Opt-in                                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query and get tools for each entity | Yes, except entities marked `@mcp: false` or `@cds.api.ignore` | Not needed                                                                                                                                                                                                                                        |
| Functions (bound and unbound)       | Yes, read-only by CDS definition                               | Not needed                                                                                                                                                                                                                                        |
| Fields marked `@mcp.omit`           | Never exposed                                                  | Not applicable                                                                                                                                                                                                                                    |
| Actions                             | No                                                             | `@mcp` on the action                                                                                                                                                                                                                              |
| Create, update, delete              | No                                                             | `@mcp.wrap.modes` on the entity                                                                                                                                                                                                                   |
| Deep insert                         | No                                                             | `@mcp.deepInsert` on the composition                                                                                                                                                                                                              |
| Writes to draft-enabled entities    | No                                                             | `@mcp.wrap.modes` on the draft root; runs through CAP's draft API in one transaction (create: NEW → SAVE; update: EDIT → patch → SAVE), so draft handlers see what they see over OData. Children are written through the root (`@mcp.deepInsert`) |
| Resources (single records by key)   | No                                                             | `@mcp.resource` on the entity                                                                                                                                                                                                                     |
| Prompts                             | No                                                             | `@mcp.prompts` on the service                                                                                                                                                                                                                     |
| MCP Apps UI (issue #133)            | No                                                             | `@mcp.ui` on the operation                                                                                                                                                                                                                        |
| Confirmation and input requests     | No                                                             | `@mcp.elicit` on the operation                                                                                                                                                                                                                    |
| Value-help completion               | No                                                             | `@mcp.completion` on the element or parameter                                                                                                                                                                                                     |
| Model description tool              | No                                                             | `@mcp.describe` on the service                                                                                                                                                                                                                    |
| Compact generic tool mode           | No                                                             | `@mcp.compact` on the service                                                                                                                                                                                                                     |

Without `@mcp` on the service, `@mcp` on a single entity or operation exposes just that
definition (entity: query + get). Functions come with the service baseline only, not with
`@mcp` on their entity.

An entity whose records cannot be addressed (no keys, or a key is `@mcp.omit`) offers only
query, plus create if listed: get, update, delete and bound operations would hit no record or
several.

### Who sees which tools

`tools/list` only shows tools CAP would not always refuse for the caller: `@requires` on the
service, the entity and the operation (a bound operation's own `@requires` replaces its
entity's), and the roles of `@restrict` grants (`READ` for query/get, `CREATE`/`UPDATE`/`DELETE`
or `WRITE` for writes, the operation's name for operations). `where` conditions only filter rows
and never hide a tool. Composition children are authorized by their parent, as in CAP. Describe
and compact tools only list the entities and operations the caller can reach. CAP still checks
every call.

### Annotations on other layers

CAP copies annotations from a db entity (or another service's entity) to every projection of it.
The plugin follows that copying in services that are themselves `@mcp`: `@mcp.omit` on
`db.Books.costPrice` hides the field in every MCP service, and `@mcp.wrap.modes` on `db.Books`
applies in every MCP service that projects it. In a service without `@mcp`, copied annotations
expose nothing and are not reported as unused; only an `@mcp` written on that service's own
entity or operation opts it in. Limitation: an `@mcp` written on a projection whose source
already has `@mcp` cannot be told apart from the copy, so it counts as copied.

Entities CAP generates on its own are never part of the baseline: localized `.texts` entities
and `DraftAdministrativeData`, unless one carries `@mcp` itself. `@mcp: false` and
`@cds.api.ignore` on an entity also remove its bound operations; `@mcp: false` on a service
removes the whole service, including members with their own `@mcp`.

## Reference

| Annotation         | On                         | Value                            | Meaning                                                                                                                                                                                                       |
| ------------------ | -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mcp`             | service, entity, operation | `true` / `false`                 | Expose (baseline) / exclude                                                                                                                                                                                   |
| `@mcp.name`        | any exposed definition     | String                           | Overrides the title shown to agents                                                                                                                                                                           |
| `@mcp.description` | any exposed definition     | String                           | Overrides the description                                                                                                                                                                                     |
| `@mcp.hint`        | element, parameter         | String                           | Overrides the element description                                                                                                                                                                             |
| `@mcp.omit`        | element                    | `true`                           | Never selected, filtered, searched, ordered by, returned or described                                                                                                                                         |
| `@mcp.wrap.modes`  | entity                     | `['create','update','delete']`   | Adds write tools. `query` and `get` are always on for an exposed entity                                                                                                                                       |
| `@mcp.deepInsert`  | composition element        | `true`                           | Create/update accept nested children                                                                                                                                                                          |
| `@mcp.resource`    | entity                     | `true`                           | One record by key at `cap://<Service>/<Entity>/<key>`; tool results link to it                                                                                                                                |
| `@mcp.prompts`     | service                    | array of prompt objects          | `{ name, title, description, template, role, inputs: [{ key, type }] }`                                                                                                                                       |
| `@mcp.ui`          | operation                  | `'ui://…'`                       | Registers the tool as an MCP App with that UI resource                                                                                                                                                        |
| `@mcp.elicit`      | operation                  | `['confirm']` or parameter names | Ask the user before running (MRTR `input_required`)                                                                                                                                                           |
| `@mcp.completion`  | element, parameter         | `true`                           | Offer `completion/complete` values (enum, value help, key list)                                                                                                                                               |
| `@mcp.describe`    | service                    | `true`                           | Adds `<Service>_describe`, scoped to what this service exposes                                                                                                                                                |
| `@mcp.compact`     | service                    | `true`                           | Generic tool set (`list_entities`, `describe_entity`, `query`, `get`, `create`, `update`, `delete`, `call_operation`) instead of per-entity and per-operation tools; `@mcp.ui` operations keep their own tool |

Unknown `@mcp.*` keys produce an `UNKNOWN_ANNOTATION` diagnostic at startup.

**Confirmation** (`@mcp.elicit`) runs nothing until the user agrees. A 2026-07-28 client that
declares the `elicitation` capability gets `resultType: input_required` with one form
(`inputRequests.confirm`); it shows the form and retries with the answer in
`inputResponses.confirm`. Accept runs the call; decline or cancel gives a
`CONFIRMATION_DECLINED` tool error. `['confirm']` asks only for a yes; listed parameter names
are also asked for, pre-filled with the agent's values, and the user's answers replace them
(parameters a form cannot hold, such as arrays, keep the agent's value). Clients that cannot ask
(2025-era, or no `elicitation` capability) get a `CONFIRMATION_REQUIRED` tool error saying why.

**MCP Apps** (`@mcp.ui: 'ui://<host>/<path>'`, ADR 0012): the tool's `_meta` links to the UI
resource, and the HTML comes from `app/mcp-apps/<path>` under the app root, read once at
startup with the MIME type `text/html;profile=mcp-app`. To supply HTML from code, or to replace
a file, register it when the plugin asks:

```js
cds.on("mcp:apps", (apps) => apps.register("ui://bookshop/stock-chart.html", () => html));
```

The function runs on every read (sync or async). A UI resource is listed and readable only for
callers who see a tool that links to it. A missing file is a startup warning, and the tool then
has no UI link; a registration no `@mcp.ui` links to is a warning and is not served.

**Prompts** are listed to callers who can reach their service (its `@requires`). Each `inputs`
entry is a required argument; prompt arguments are strings on the wire, so an `Integer` or
`Decimal` input must look like a number and a `Boolean` one is `true` or `false`. `prompts/get`
returns the template as one message with the given `role`, each `{{key}}` replaced by its
argument.

## Diagnostics

The model reader and the exposure registry report these; the startup report (M6) prints them. Targets are written
`Def`, `Def:element`, `Entity.boundOperation` or `Operation:param`.

| Code                           | Level | When                                                                                                                                                                                                                                                                                                                         | Effect                                                                                     |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `UNKNOWN_ANNOTATION`           | warn  | An `@mcp.*` key v2 does not know, anywhere in the model (incl. qualified `#x` keys)                                                                                                                                                                                                                                          | Ignored                                                                                    |
| `V1_ANNOTATION`                | warn  | `@mcp.wrap.tools`, `@mcp.tool`, `@mcp.usePrimaryKey`, or `@mcp.resource: [ … ]`                                                                                                                                                                                                                                              | Ignored (M6 shim maps)                                                                     |
| `INVALID_ANNOTATION_VALUE`     | error | An unknown `@mcp.wrap.modes` value; `update`/`delete` on an entity without exposed keys; an `@mcp.ui` value that is not `ui://…`; an `@mcp.prompts` entry without name or template, or with a role other than user/assistant; an `@mcp.elicit` value that is neither `confirm` nor a parameter (the call is still confirmed) | That value (or prompt) is ignored                                                          |
| `BOUND_OPERATION_WITHOUT_KEYS` | error | An exposed bound operation on an entity without exposed keys (none, or one is `@mcp.omit`)                                                                                                                                                                                                                                   | The operation is not exposed                                                               |
| `UNUSED_ANNOTATION`            | warn  | An `@mcp.*` feature annotation on a service, entity or operation that is not exposed (e.g. `@mcp.wrap.modes` in a service without `@mcp`)                                                                                                                                                                                    | The annotation has no effect                                                               |
| `PARAMETER_SHADOWS_KEY`        | error | A bound operation parameter has the name of a key of its entity                                                                                                                                                                                                                                                              | The operation is not exposed                                                               |
| `DRAFT_WRITE_NOT_SUPPORTED`    | error | `@mcp.wrap.modes` write modes on a composition child of a draft                                                                                                                                                                                                                                                              | Those modes are not offered; write the child through its root with `@mcp.deepInsert`       |
| `UNSUPPORTED_TYPE`             | warn  | An exposed element or parameter whose type has no JSON Schema mapping (e.g. `Vector`)                                                                                                                                                                                                                                        | Exposed as "any value"                                                                     |
| `OMITTED_KEY`                  | warn  | `@mcp.omit` on a key of an exposed entity                                                                                                                                                                                                                                                                                    | Only query (and create) are offered for it                                                 |
| `PROMPT_NAME_CLASH`            | error | Two `@mcp.prompts` entries (in one service or across services) have the same name. Target is the prompt name                                                                                                                                                                                                                 | Neither is exposed                                                                         |
| `TOOL_NAME_CLASH`              | error | Two tools would get the same name (also across services, e.g. `A.B_C` and `A_B.C`). Target is the tool name                                                                                                                                                                                                                  | Neither is exposed, unless one is the plugin's own (describe, compact set): that one stays |
| `INVALID_TOOL_NAME`            | error | A tool name outside MCP's `[A-Za-z0-9._-]{1,128}` (spaces, non-ASCII, very long namespaces). Target is the tool name                                                                                                                                                                                                         | The tool is not exposed                                                                    |
| `LONG_TOOL_NAME`               | warn  | A tool name over 64 characters, which some LLM tool APIs reject                                                                                                                                                                                                                                                              | Exposed                                                                                    |

## Names and descriptions

- Description: `@mcp.description` → `@description` → doc comment (`/** … */`) → `@title` → none.
- Title: `@mcp.name` → `@title` → definition name.
- Element description: `@mcp.hint` → `@description` → doc comment.
- Doc comments need `cds.env.cdsc.docs = true` in the app's own config. The plugin does not set
  it, because it also changes the app's OData `$metadata` (ADR 0011).

## Configuration (`cds.env.mcp`)

camelCase, read through `cds.env` only (profiles work as usual). No key turns a feature on.

| Key                  | Default                          | Meaning                                                                            |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `path`               | `/mcp`                           | Endpoint path                                                                      |
| `allowedOrigins`     | none                             | Browser origins other than the app's own that may call `/mcp` (others get 403)     |
| `name`, `version`    | `@gavdi/cap-mcp` and its version | Server identity in `server/discover` and `initialize`; set them to tell apps apart |
| `instructions`       | none                             | String, or `{ file }` (M6, not read yet)                                           |
| `limits.maxRows`     | `200`                            | Upper bound for `top`                                                              |
| `limits.defaultRows` | `25`                             | Default page size                                                                  |

Read once, when CAP has served the app (`allowedOrigins` per request). Final key list is settled in M6; add keys only with a test and a row here.

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
