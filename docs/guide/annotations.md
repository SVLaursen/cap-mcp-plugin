# Annotation reference

Everything is opt-in: nothing appears over MCP unless an annotation asks for it, and no
configuration switches a feature on. `@mcp` on a service gives a read-only baseline; anything
that writes, changes the agent's workflow or adds an MCP feature needs its own annotation.

## What `@mcp` gives, and what needs more

| Capability                          | `@mcp` on the service gives it                          | Otherwise opt in with                                     |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Query and get tools for each entity | Yes, except `@mcp: false` or `@cds.api.ignore` entities |                                                           |
| Functions (bound and unbound)       | Yes                                                     |                                                           |
| Actions                             | No                                                      | `@mcp` on the action                                      |
| Create, update, delete              | No                                                      | `@mcp.wrap.modes` on the entity                           |
| Nested children in create/update    | No                                                      | `@mcp.deepInsert` on the composition                      |
| Writes to draft-enabled entities    | No                                                      | `@mcp.wrap.modes` on the draft root                       |
| Single records as resources         | No                                                      | `@mcp.resource` on the entity                             |
| Prompts                             | No                                                      | `@mcp.prompts` on the service                             |
| MCP Apps UI                         | No                                                      | `@mcp.ui` on the operation                                |
| Confirmation before a call          | No                                                      | `@mcp.elicit` on the operation                            |
| Key completion                      | No                                                      | `@mcp.completion` on the key of an `@mcp.resource` entity |
| Model description tool              | No                                                      | `@mcp.describe` on the service                            |
| Compact generic tool set            | No                                                      | `@mcp.compact` on the service                             |

Without `@mcp` on the service, `@mcp` on a single entity exposes just that entity (query and
get), and `@mcp` on a single operation exposes just that operation. Functions come with the
service's `@mcp` only, not with `@mcp` on their entity.

```cds
service CatalogService {
  @mcp entity Books { key ID : Integer; title : String; stock : Integer; }
  entity Notes { key ID : Integer; text : String; } // not exposed
}
```

## All annotations

| Annotation         | On                         | Value                            | Meaning                                                                                      |
| ------------------ | -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `@mcp`             | service, entity, operation | `true` / `false`                 | Expose (baseline) / exclude                                                                  |
| `@mcp.name`        | any exposed definition     | String                           | The title shown to agents (never the tool name)                                              |
| `@mcp.description` | any exposed definition     | String                           | The description shown to agents                                                              |
| `@mcp.hint`        | element, parameter         | String                           | The field's description                                                                      |
| `@mcp.omit`        | element                    | `true`                           | Never selected, filtered, searched, ordered by, returned or described                        |
| `@mcp.wrap.modes`  | entity                     | `['create','update','delete']`   | Adds write tools (`query` and `get` are always on)                                           |
| `@mcp.deepInsert`  | composition element        | `true`                           | Create and update accept nested children                                                     |
| `@mcp.resource`    | entity                     | `true`                           | One record by key at `cap://<Service>/<Entity>/<key>`; tool results link to it               |
| `@mcp.prompts`     | service                    | List of prompts                  | `{ name, title, description, template, role, inputs: [{ key, type }] }`                      |
| `@mcp.ui`          | operation                  | `'ui://<host>/<path>'`           | The tool is an MCP App with that UI resource                                                 |
| `@mcp.elicit`      | operation                  | `['confirm']` or parameter names | The user confirms (and may correct those parameters) before the call runs                    |
| `@mcp.completion`  | key element                | `true`                           | Clients can complete key values of that entity's resource template                           |
| `@mcp.describe`    | service                    | `true`                           | Adds `<Service>_describe`, describing what the service exposes to the caller                 |
| `@mcp.compact`     | service                    | `true`                           | A generic tool set (`query`, `get`, `create`, …, with the entity as an argument) per service |

A misspelled `@mcp.*` key is reported at startup (`UNKNOWN_ANNOTATION`) and has no effect.

## Writes

```cds
service OrdersService {
  entity Orders { key ID : UUID; status : String; items : Composition of many Items on items.order = $self; }
  entity Items { key ID : UUID; order : Association to Orders; book : Integer; quantity : Integer; }
}
annotate OrdersService with @mcp;
annotate OrdersService.Orders with @mcp.wrap.modes: ['create', 'update', 'delete'];
annotate OrdersService.Orders with { items @mcp.deepInsert; };
```

- Writes run through the CAP service, so your handlers, `@mandatory`, `@assert.*` and
  `@restrict` apply exactly as over OData. Readonly fields (`@readonly`, `@Core.Computed`,
  managed fields) are never write inputs.
- `update` and `delete` need the entity's keys. An entity without keys, or with an `@mcp.omit`
  key, offers only query (and create).
- **Drafts:** on a draft root (`@odata.draft.enabled`), create runs NEW → SAVE and update runs
  EDIT → patch → SAVE in one transaction, so your draft handlers (`before SAVE`, …) run as they
  do for Fiori. Composition children of a draft are written through the root with
  `@mcp.deepInsert`; write modes on the child itself are refused (`DRAFT_WRITE_NOT_SUPPORTED`).

## Operations

```cds
service CatalogService {
  entity Books { key ID : Integer; title : String; stock : Integer; }
    actions {
      function availability() returns Integer; // baseline: bound function
      @mcp action reserve(quantity : Integer);  // opt-in: bound action
    };
  function topSeller() returns Books;           // baseline: unbound function
  @mcp action submitOrder(book : Books:ID, quantity : Integer @mandatory);
  action restock(book : Books:ID, quantity : Integer); // not exposed
}
annotate CatalogService with @mcp;
```

Bound operations take their entity's keys as arguments, next to their own parameters. A
parameter with the name of one of the entity's keys is refused (`PARAMETER_SHADOWS_KEY`).

## Who sees which tools

`tools/list` shows only the tools CAP would not always refuse for the caller:

- `@requires` on the service, the entity and the operation (a bound operation's own `@requires`
  replaces its entity's);
- the roles of `@restrict` grants: `READ` for query and get, `CREATE` / `UPDATE` / `DELETE` or
  `WRITE` for writes, the operation's name for operations.

`where` conditions in `@restrict` filter rows and never hide a tool. This is advertising, not
enforcement: CAP checks every call, as it does for OData.

## Annotations on other layers

CAP copies annotations from a database entity to every projection of it, and the plugin follows
that in services that have `@mcp`: `@mcp.omit` on `db.Books.costPrice` hides the field in every
MCP service. In a service without `@mcp`, copied annotations expose nothing.

```cds
namespace my;
entity Books { key ID : Integer; title : String; costPrice : Decimal @mcp.omit; }
@mcp service CatalogService { entity Books as projection on my.Books; }
```

CAP's generated entities (localized `.texts`, `DraftAdministrativeData`) are never part of the
baseline. `@mcp: false` or `@cds.api.ignore` on an entity also removes its bound operations;
`@mcp: false` on a service removes the whole service.

## Names and descriptions

- **Tool names** are `<Service>_<Entity>_<mode>` (`CatalogService_Books_query`) and
  `<Service>_<operation>` (bound: `<Service>_<Entity>_<operation>`). The service's namespace is
  dropped and dots become `_`. In an `@mcp.compact` service they are `<Service>_query`,
  `<Service>_get`, … with the entity as an argument.
- **Title:** `@mcp.name` → `@title` → the definition's name.
- **Description:** `@mcp.description` → `@description` → doc comment (`/** … */`) → `@title`.
- **Field description:** `@mcp.hint` → `@description` → doc comment.

Doc comments reach the plugin only with `"cdsc": { "docs": true }` in your app's cds config
(`cds add mcp --docs` sets it). It also puts them into the OData `$metadata`, so the plugin
leaves the choice to you. When it is off, the startup report says (outside production) which
exposed definitions lost a doc comment.

## Tool arguments and results

| Tool        | Arguments                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| query       | `q` (search), `where: [{ field, op, value }]`, `orderby: [{ field, dir }]`, `select: [field]`, `top`, `cursor` |
| get, delete | The keys                                                                                                       |
| create      | Writable fields (mandatory ones required), nested compositions with `@mcp.deepInsert`                          |
| update      | The keys plus any writable field                                                                               |
| operation   | Its parameters; bound operations also take their entity's keys                                                 |

`op` is one of `eq ne gt ge lt le in contains startswith endswith`; all `where` conditions must
hold. `q` uses CAP's search (`@cds.search`), minus omitted fields. `top` defaults to 25 and is at
most 200 (configurable, see [Configuration](../../README.md#configuration)).

Results come back as `structuredContent` plus one text block: query gives
`{ rows, total, nextCursor }`, get/create/update give the record, operations give `{ value }`.
Errors keep CAP's `code`, `message`, `target` and `details`, translated to the caller's locale.

## Further features

[Resources, prompts, confirmation and completion](features.md) and [MCP Apps](mcp-apps.md)
describe the remaining annotations in detail. The full contract, including every diagnostic, is
[docs/annotations.md](../annotations.md).
