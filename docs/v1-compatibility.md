# v1 compatibility checklist

What a v1 app gets after upgrading to v2 with its v1 annotations unchanged (the v1 shim,
docs/annotations.md "Migrating from v1"). The reference app is v1's own demo
(gavdilabs/cap-mcp-plugin 1.8, `test/demo`, with its config: `wrap_entities_to_actions: true`,
`wrap_entity_modes: ['query','get']`, `auth: 'none'`, an instructions file).
`test/contract/v1-compatibility.test.ts` pins every row. Change both together.

## Tools

| v1 tool                                                            | v2 tool                                                  | Same?                          |
| ------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------ |
| `CatalogService_Books_{query,get,create,update,delete}`            | Same names                                               | ✔                              |
| `CatalogService_Authors_{query,get,create,update}`                 | Same names                                               | ✔                              |
| `AdminService_Books_{query,get}` (from `wrap_entities_to_actions`) | Same names (from the list form of `@mcp.resource`)       | ✔                              |
| `get-stock`                                                        | `CatalogService_Books_getStock` (title `get-stock`)      | Renamed                        |
| `get-stock-as-admin`                                               | `AdminService_Books_getStock`                            | Renamed                        |
| `get-multi-key`                                                    | `CatalogService_MultiKeyExamples_getMultiKey`            | Renamed                        |
| `get-author` (elicits `input`)                                     | `CatalogService_getAuthor`, confirms `id` (MRTR)         | Renamed                        |
| `get-author-details`                                               | `CatalogService_getAuthorDetails`                        | Renamed                        |
| `books-by-author` (elicits `input`, `confirm`)                     | `CatalogService_getBooksByAuthor`, confirms `authorName` | Renamed                        |
| `book-recommendation`                                              | `CatalogService_getBookRecommendation`                   | Renamed                        |
| `book-recommendation-admin-service`                                | `AdminService_getBookRecommendation`                     | Renamed                        |
| `cap_describe_model` (on by default)                               | None; `@mcp.describe` per service                        | Dropped (`V1_DEFAULT_CHANGED`) |

Operation tools in v2 are `<Service>_<operation>`; v1's `@mcp.name` becomes the tool's title.
Entity tool names did not change. Who sees a tool is CAP's `@requires` / `@restrict`, as in v1.

## Resources, prompts, config

| v1                                                        | v2                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Resource templates `books`, `admin-books` (OData options) | None: the query tools cover it (ADR 0006)                    |
| Resource template `authors` (`resource: true`)            | `cap://CatalogService/Authors/{key}`, one record by key      |
| Prompt `give-me-book-abstract`                            | Unchanged                                                    |
| `name`, `version`, `instructions: { file }`               | Unchanged                                                    |
| `auth: 'none'`                                            | Ignored: CAP's own auth applies (`V1_DEFAULT_CHANGED`)       |
| `wrap_entities_to_actions`, `wrap_entity_modes`           | Ignored (`V1_DEFAULT_CHANGED`); the annotations above decide |
| Field hints (`@mcp.hint`), `@mcp.omit`                    | Unchanged                                                    |
| `@mcp.description` on an entity                           | Unchanged (the entity's description)                         |
| `@mcp.wrap.hint` (per entity or per mode)                 | Dropped (`V1_ANNOTATION`): use `@mcp.description`            |

## Checklist for an upgrade

- [ ] Read the startup report: every `V1_ANNOTATION` and `V1_DEFAULT_CHANGED` names what to write.
- [ ] Update agent prompts or client configs that call operation tools by their v1 name.
- [ ] Add `@mcp.wrap.modes` where the report says create/update came from v1's default.
- [ ] Add `@mcp.describe` to a service if agents relied on `cap_describe_model`.
- [ ] Replace v1 annotations with `@mcp` (the shim's messages say where), then remove v1 config keys.
- [ ] Set CAP's auth for local use (`dummy` / `mocked`) if the app used `auth: 'none'`.
