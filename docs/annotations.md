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
| Key completion                      | No                                                             | `@mcp.completion` on the key of an `@mcp.resource` entity                                                                                                                                                                                         |
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
| `@mcp.completion`  | key element                | `true`                           | `completion/complete` offers key values for that entity's `cap://` resource template. Single-key `@mcp.resource` entities only: MCP has no completion for tool arguments                                      |
| `@mcp.describe`    | service                    | `true`                           | Adds `<Service>_describe`, scoped to what this service exposes                                                                                                                                                |
| `@mcp.compact`     | service                    | `true`                           | Generic tool set (`list_entities`, `describe_entity`, `query`, `get`, `create`, `update`, `delete`, `call_operation`) instead of per-entity and per-operation tools; `@mcp.ui` operations keep their own tool |

Unknown `@mcp.*` keys produce an `UNKNOWN_ANNOTATION` diagnostic at startup.

**Confirmation** (`@mcp.elicit`) runs nothing until the user agrees. A 2026-07-28 client that
declares the `elicitation` capability gets `resultType: input_required` with one form
(`inputRequests.confirm`) and a `requestState`; it shows the form and retries the same call
with the answer in `inputResponses.confirm` and the `requestState` echoed. Accept runs the call
only when the retry is the call the form asked about (same tool, arguments and user); otherwise
the user is asked again; decline or cancel gives a
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

Register inside the listener, synchronously: the plugin emits `mcp:apps` once, when CAP has
served the app, and checks the registrations right after it (an `async` listener that awaits
first still registers, but after the startup warnings). The function you register runs on
every read and may be async. A UI resource is listed and readable only for
callers who see a tool that links to it. A missing file is a startup warning (unless app code registers that URI), and the tool then
has no UI link; a registration no `@mcp.ui` links to is a warning and is not served.

**Completion** (`@mcp.completion` on the key of a single-key `@mcp.resource` entity): a client
sends `completion/complete` with `ref/resource` and the template
`cap://<Service>/<Entity>/{key}`; the plugin answers with keys that start with the typed value,
in key order, as the caller may read them (CAP applies `@restrict`). At most 100 values, with
`hasMore` when there are more. MCP 2026-07-28 completes resource-template variables and prompt
arguments only, so `@mcp.completion` on an operation parameter has no effect (a diagnostic says
so).

**Prompts** are listed to callers who can reach their service (its `@requires`). Each `inputs`
entry is a required argument; prompt arguments are strings on the wire, so an `Integer` or
`Decimal` input must look like a number and a `Boolean` one is `true` or `false`. `prompts/get`
returns the template as one message with the given `role`, each `{{key}}` replaced by its
argument.

## Diagnostics

The model reader and the exposure registry report these. When CAP has served the app, the plugin
logs a startup report on the `mcp` channel: `serving N tools, M resources, P prompts at /mcp`
(everything the app exposes, counted for a user with every role), then each diagnostic as
`CODE target: message`, errors first, at its own level. An unknown or v1 key that CAP copied to
projections is reported once, where it was written, with the copies listed in its message.
Targets are written
`Def`, `Def:element`, `Entity.boundOperation` or `Operation:param`.

| Code                           | Level | When                                                                                                                                                                                                                                                                                                                                                                                                                                | Effect                                                                                     |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `UNKNOWN_ANNOTATION`           | warn  | An `@mcp.*` key v2 does not know, anywhere in the model (incl. qualified `#x` keys)                                                                                                                                                                                                                                                                                                                                                 | Ignored                                                                                    |
| `V1_ANNOTATION`                | warn  | A v1 annotation: `@mcp.tool`, `@mcp.wrap.tools`, `@mcp.resource: [ … ]`, `@mcp.elicit: ['input']` (mapped, see Migrating from v1), or `@mcp.usePrimaryKey`, `@mcp.wrap.name`, `@mcp.wrap.hint[.<mode>]` (dropped)                                                                                                                                                                                                                   | Mapped to the v2 annotation, or ignored                                                    |
| `V1_DEFAULT_CHANGED`           | warn  | Something a v1 app got by default or from v1 config that v2 does not give: create/update from `wrap_entity_modes` on a v1-wrapped entity without `@mcp.wrap.modes`; tools from `wrap_entities_to_actions` on an `@mcp.resource: true` entity; the describe tool (`enable_model_description`, unless set to `false`); and every v1 config key (`auth`, `capabilities`, `wrap_*`, `enable_model_description`), target `cds.mcp.<key>` | Not given; the message says which annotation keeps it                                      |
| `INVALID_ANNOTATION_VALUE`     | error | An unknown `@mcp.wrap.modes` value; `update`/`delete` on an entity without exposed keys; an `@mcp.ui` value that is not `ui://…`; an `@mcp.prompts` entry without name or template, or with a role other than user/assistant; an `@mcp.elicit` value that is neither `confirm` nor a parameter, or an empty `@mcp.elicit` list (the call is still confirmed)                                                                        | That value (or prompt) is ignored                                                          |
| `BOUND_OPERATION_WITHOUT_KEYS` | error | An exposed bound operation on an entity without exposed keys (none, or one is `@mcp.omit`)                                                                                                                                                                                                                                                                                                                                          | The operation is not exposed                                                               |
| `UNUSED_ANNOTATION`            | warn  | An `@mcp.*` feature annotation on a service, entity or operation that is not exposed (e.g. `@mcp.wrap.modes` in a service without `@mcp`); `@mcp.completion` anywhere but the single key of an `@mcp.resource` entity (unless CAP copied it there from the projected entity)                                                                                                                                                        | The annotation has no effect                                                               |
| `PARAMETER_SHADOWS_KEY`        | error | A bound operation parameter has the name of a key of its entity                                                                                                                                                                                                                                                                                                                                                                     | The operation is not exposed                                                               |
| `DRAFT_WRITE_NOT_SUPPORTED`    | error | `@mcp.wrap.modes` write modes on a composition child of a draft                                                                                                                                                                                                                                                                                                                                                                     | Those modes are not offered; write the child through its root with `@mcp.deepInsert`       |
| `UNSUPPORTED_TYPE`             | warn  | An exposed element or parameter whose type has no JSON Schema mapping (e.g. `Vector`)                                                                                                                                                                                                                                                                                                                                               | Exposed as "any value"                                                                     |
| `OMITTED_KEY`                  | warn  | `@mcp.omit` on a key of an exposed entity                                                                                                                                                                                                                                                                                                                                                                                           | Only query (and create) are offered for it                                                 |
| `PROMPT_NAME_CLASH`            | error | Two `@mcp.prompts` entries (in one service or across services) have the same name. Target is the prompt name                                                                                                                                                                                                                                                                                                                        | Neither is exposed                                                                         |
| `TOOL_NAME_CLASH`              | error | Two tools would get the same name (also across services, e.g. `A.B_C` and `A_B.C`). Target is the tool name                                                                                                                                                                                                                                                                                                                         | Neither is exposed, unless one is the plugin's own (describe, compact set): that one stays |
| `INVALID_TOOL_NAME`            | error | A tool name outside MCP's `[A-Za-z0-9._-]{1,128}` (spaces, non-ASCII, very long namespaces). Target is the tool name                                                                                                                                                                                                                                                                                                                | The tool is not exposed                                                                    |
| `LONG_TOOL_NAME`               | warn  | A tool name over 64 characters, which some LLM tool APIs reject                                                                                                                                                                                                                                                                                                                                                                     | Exposed                                                                                    |
| `UNKNOWN_CONFIG`               | warn  | A `cds.env.mcp` key the plugin does not know (target `cds.mcp.<key>`)                                                                                                                                                                                                                                                                                                                                                               | Ignored                                                                                    |
| `INVALID_CONFIG`               | error | A `cds.env.mcp` value of the wrong shape, an unreadable instructions file, or `defaultRows` above `maxRows`                                                                                                                                                                                                                                                                                                                         | That key's default is used                                                                 |

## Names and descriptions

- Description: `@mcp.description` → `@description` → doc comment (`/** … */`) → `@title` → none.
- Title: `@mcp.name` → `@title` → definition name.
- Element description: `@mcp.hint` → `@description` → doc comment.
- Doc comments need `cds.env.cdsc.docs = true` in the app's own config. The plugin does not set
  it, because it also changes the app's OData `$metadata` (ADR 0011). When it is off, outside
  production (`NODE_ENV` or CAP's `production` profile), the plugin compiles the sources once more
  with doc comments, beside startup rather than before it, and logs the exposed definitions that
  lost one (an `info` line with the setting to add).

## Setup: `cds add mcp`

With the plugin installed (`npm add @gavdi/cap-mcp`), `cds add mcp --service CatalogService`
writes `annotate CatalogService with @mcp;` to `srv/mcp.cds` (adding to the file if it exists;
external services are never candidates),
adds the dependency if it is in neither `dependencies` nor `devDependencies`, and an `mcp` block with the app's name and version.
`--service` takes a comma-separated list and is required when the app has several services;
`--docs` also sets `cdsc.docs` (ADR 0011). Existing config values are never overwritten.

## Configuration (`cds.env.mcp`)

camelCase, read through `cds.env` only (profiles work as usual). No key turns a feature on.

| Key                  | Default                          | Meaning                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | `/mcp`                           | Endpoint path                                                                                                                                                                                                                                                                                                                   |
| `allowedOrigins`     | none                             | Browser origins that may call `/mcp`. A request with an `Origin` header that is not listed gets 403, including the app's own origin (it would come from the Host header, which DNS rebinding controls); requests without `Origin` (native clients, bridges) are not affected                                                    |
| `name`, `version`    | `@gavdi/cap-mcp` and its version | Server identity in `server/discover` and `initialize`; set them to tell apps apart                                                                                                                                                                                                                                              |
| `tenantHostPattern`  | none                             | Multitenant XSUAA: a regular expression over the host the client called; its first capture group is the subscriber's subdomain (as the approuter's `TENANT_HOST_PATTERN`). The RFC 9728 metadata then names `https://<subdomain>.<uaadomain>`; no match keeps `credentials.url`                                                 |
| `instructions`       | none                             | Server instructions sent to clients: a string, or `{ file }` relative to the app root, read once at startup (a missing file is an error and the server has none). `cds build` copies the file to `gen/srv/<file>` and warns when it is missing or an absolute path; with an explicit `build.tasks` list, add `{ "for": "mcp" }` |
| `limits.maxRows`     | `200`                            | Upper bound for `top`                                                                                                                                                                                                                                                                                                           |
| `limits.defaultRows` | `25`                             | Default page size                                                                                                                                                                                                                                                                                                               |

Read once, when CAP has served the app; a change needs a restart, as for the rest of CAP. This is
the full list:
an unknown key is an `UNKNOWN_CONFIG` warning, and a value of the wrong shape (or the whole block
as a JSON string, which v1 accepted) is an `INVALID_CONFIG` error, after which that key's default
is used. `limits.defaultRows` is never above `limits.maxRows`. Add keys only with a test and a row
here.

**Row limits are CAP's too.** CAP's paging applies to MCP's queries as to OData's: `@cds.query.limit:
{ default, max }` on an entity (else its service) and the global `cds.query.limit.max`. A query
tool advertises and uses the lower of CAP's limits and these, so an agent asking for more than CAP
serves gets an `INVALID_ARGUMENT` instead of a silently shorter page. The entity's (or its
service's) CAP `default` replaces `limits.defaultRows`; CAP's global `cds.query.limit.default`
does not, and a CAP `default: 0` counts as unset. MCP can be stricter than OData but never looser:
the global `cds.query.limit.max` caps every entity here, even one whose own `max` is higher. The
compact `<Service>_query` tool advertises these limits and enforces each entity's own. Resource
key completion stays within them too. Operations that return arrays are not paged, as over OData.

## Migrating from v1

v2 reads v1 annotations through a shim, so a v1 app keeps working while you move it over. Each v1
annotation is an explicit opt-in, so the shim maps it to its v2 equivalent and reports a
`V1_ANNOTATION` warning saying what to write instead. v1 config never switches anything on in v2
(ADR 0004): what the app got from it, or from a v1 default, and no longer gets is a
`V1_DEFAULT_CHANGED` warning naming the annotation that keeps it. Both show in the startup report.
v1 keys only count on the kind of definition v1 read them on (`@mcp.tool` on operations,
`@mcp.wrap.tools` and the list form of `@mcp.resource` on entities of a service); elsewhere, such
as on a service or on a db entity that projections copy from, they are reported and expose
nothing. `docs/v1-compatibility.md` walks through v1's own demo app, tool by tool.

| v1                                                       | v2 (what the shim does)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mcp.wrap.tools: true` on an entity                     | Mapped to `@mcp` on the entity: query and get, plus the writes in `@mcp.wrap.modes` (or `wrap_entity_modes` with `wrap_entities_to_actions`)                                                                                                                                                                                                                                                                                                                     |
| `@mcp.resource: ['filter', 'top', …]` on an entity       | Mapped to `@mcp` on the entity as query and get tools, never writes (maintainer decision, M6 review): v1 served it as a read-only resource template, and v2 dropped those (ADR 0006). `@mcp.wrap.modes` adds writes only where v1 also wrapped the entity as tools (`@mcp.wrap.tools: true`, or `wrap_entities_to_actions` with `wrap.tools` unset); `@mcp.wrap.tools: false` exposes nothing. Not a v2 resource: `@mcp.resource: true` now means single records |
| `@mcp.resource: true`                                    | Same name, new meaning: a single-record resource of an exposed entity. Alone it exposes nothing (add `@mcp` or keep `@mcp.wrap.tools`)                                                                                                                                                                                                                                                                                                                           |
| `@mcp.wrap.modes`                                        | Same name; `query`/`get` no longer need listing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@mcp.tool: true` on an action/function                  | Mapped to `@mcp` on it; functions are baseline under `@mcp` on the service                                                                                                                                                                                                                                                                                                                                                                                       |
| `@mcp.elicit: ['input', …]`                              | `'input'` is mapped to the operation's parameter names (`'confirm'` when it has none)                                                                                                                                                                                                                                                                                                                                                                            |
| `@mcp.name`, `@mcp.description` (required)               | Optional; fall back to CDS `@title`, `@description`, doc comments. `@mcp.name` is the title now, never the tool name                                                                                                                                                                                                                                                                                                                                             |
| `@mcp.usePrimaryKey`, `@mcp.wrap.name`, `@mcp.wrap.hint` | Dropped (keys are always the entity keys; names are `<Service>_<Entity>_<mode>`; use `@mcp.description`)                                                                                                                                                                                                                                                                                                                                                         |
| config `wrap_entities_to_actions`                        | Ignored; use `@mcp` on the service or entity                                                                                                                                                                                                                                                                                                                                                                                                                     |
| config `wrap_entity_modes` (defaulted to create/update)  | Ignored; writes need `@mcp.wrap.modes`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| config `enable_model_description` (default on)           | Ignored; `@mcp.describe` on the service (default off)                                                                                                                                                                                                                                                                                                                                                                                                            |
| config `auth: none`                                      | Ignored; use CAP's own auth config (`dummy` / `mocked` for local)                                                                                                                                                                                                                                                                                                                                                                                                |
| config `capabilities.*.listChanged`                      | Ignored; v2 lists never change while serving                                                                                                                                                                                                                                                                                                                                                                                                                     |
| config as a JSON string                                  | Not read (`INVALID_CONFIG`); write it as an object                                                                                                                                                                                                                                                                                                                                                                                                               |
