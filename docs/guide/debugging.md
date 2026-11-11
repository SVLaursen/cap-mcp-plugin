# Debug a missing tool

A tool you expected is not in `tools/list`. Work down this list.

## 1. Read the startup report

When CAP has served the app, the plugin logs one summary line and every diagnostic:

```
[mcp] - serving 12 tools, 1 resource, 1 prompt at /mcp
[mcp] - UNKNOWN_ANNOTATION CatalogService.Books: Unknown annotation @mcp.wrap.mode on CatalogService.Books; it has no effect
```

The summary counts tools for a user with every role. If your tool is not counted there, the
model is the problem (steps 2–4); if it is counted but your client does not see it, it is the
caller (step 5). Each diagnostic code is explained in
[docs/annotations.md](../annotations.md#diagnostics). Common ones:

| Code                                                    | Usual cause                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `UNKNOWN_ANNOTATION`                                    | A typo in an `@mcp.*` key                                                              |
| `UNUSED_ANNOTATION`                                     | A feature annotation on something that is not exposed (no `@mcp` on it or its service) |
| `V1_ANNOTATION`                                         | A v1 annotation; the message says what to write instead                                |
| `INVALID_ANNOTATION_VALUE`                              | A value v2 does not accept (e.g. an unknown `@mcp.wrap.modes` entry)                   |
| `TOOL_NAME_CLASH`, `INVALID_TOOL_NAME`                  | Two definitions map to one name, or a name MCP does not allow                          |
| `BOUND_OPERATION_WITHOUT_KEYS`, `PARAMETER_SHADOWS_KEY` | A bound operation that could not address its record                                    |
| `UNKNOWN_CONFIG`, `INVALID_CONFIG`                      | A `cds.mcp` setting that is misspelled or of the wrong shape                           |

## 2. Is it opted in?

Everything is opt-in:

- Entities and functions need `@mcp` on their service, or on themselves.
- **Actions** need `@mcp` on the action, even in an `@mcp` service.
- **Create, update, delete** need `@mcp.wrap.modes` on the entity.
- `@mcp: false` or `@cds.api.ignore` removes an entity (and its bound operations).
- CAP-generated entities (`.texts`, `DraftAdministrativeData`) are never in the baseline.

```cds
@mcp service CatalogService {
  entity Books { key ID : Integer; stock : Integer; }
  @mcp action restock(book : Integer, quantity : Integer);
}
annotate CatalogService.Books with @mcp.wrap.modes: ['update'];
```

## 3. Is it under the name you expect?

Tools are `<Service>_<Entity>_<mode>` and `<Service>_<operation>` (bound:
`<Service>_<Entity>_<operation>`), with the service's namespace dropped and dots as `_`.
In an `@mcp.compact` service there are no per-entity tools: look for
`<Service>_query`, `<Service>_create`, … with the entity as an argument.

## 4. Can its records be addressed?

`get`, `update`, `delete` and bound operations need the entity's keys. An entity without keys,
or with an `@mcp.omit` key, offers only query (and create): see `OMITTED_KEY` and
`BOUND_OPERATION_WITHOUT_KEYS` in the report.

## 5. Can this user call it?

`tools/list` leaves out tools CAP would always refuse for the caller: `@requires` on the
service, entity or operation, and the roles of `@restrict` grants (`READ` for query and get,
`CREATE`/`UPDATE`/`DELETE` or `WRITE` for writes, the operation's name for operations).
Compare with OData as the same user: if `GET /odata/v4/catalog/Books` is a 403 for them, the
tool is hidden for them too. Check the roles your token actually carries.

## 6. Still stuck?

Turn on debug logs for the plugin: `"cds": { "log": { "levels": { "mcp": "debug" } } }`, or
`DEBUG=mcp cds watch`. Then call `tools/list` from the MCP Inspector as the user in question.
