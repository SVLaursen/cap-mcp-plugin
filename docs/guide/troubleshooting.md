# Troubleshooting

## The startup report

When CAP has served the app, the plugin logs one summary line on the `mcp` channel, then every
diagnostic, errors first:

```
[mcp] - serving 12 tools, 1 resource, 1 prompt at /mcp
[mcp] - UNKNOWN_ANNOTATION CatalogService.Books: Unknown annotation @mcp.wrap.mode on CatalogService.Books; it has no effect
```

The summary counts what the app exposes to a user with every role. Each diagnostic is
`CODE target: message`, at its own log level. Targets are written `Def`, `Def:element`,
`Entity.boundOperation` or `Operation:param`. A typo in a db entity that CAP copied to several
projections is reported once, where it was written.

Outside production, when `cdsc.docs` is off, an extra `info` line names the exposed definitions
whose doc comments MCP does not see, and how to turn them on.

### Diagnostics

| Code                           | Level | Usual cause                                                                                                              | Effect                                                    |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `UNKNOWN_ANNOTATION`           | warn  | A typo in an `@mcp.*` key                                                                                                | Ignored                                                   |
| `UNUSED_ANNOTATION`            | warn  | A feature annotation on something not exposed; `@mcp.completion` anywhere but an `@mcp.resource` key                     | No effect                                                 |
| `V1_ANNOTATION`                | warn  | A v1 annotation; the message says what to write instead                                                                  | Mapped to v2, or ignored                                  |
| `V1_DEFAULT_CHANGED`           | warn  | Something v1 gave by default or from v1 config that v2 does not                                                          | Not given; the message names the annotation that keeps it |
| `INVALID_ANNOTATION_VALUE`     | error | A value v2 does not accept (unknown `@mcp.wrap.modes` entry, `@mcp.ui` not `ui://…`, bad prompt, …)                      | That value is ignored                                     |
| `BOUND_OPERATION_WITHOUT_KEYS` | error | A bound operation on an entity without exposed keys                                                                      | The operation is not exposed                              |
| `PARAMETER_SHADOWS_KEY`        | error | A bound operation parameter named like a key of its entity                                                               | The operation is not exposed                              |
| `DRAFT_WRITE_NOT_SUPPORTED`    | error | Write modes on a composition child of a draft                                                                            | Write the child through its root with `@mcp.deepInsert`   |
| `UNSUPPORTED_TYPE`             | warn  | An element type without a JSON Schema mapping (e.g. `Vector`)                                                            | Exposed as "any value"                                    |
| `OMITTED_KEY`                  | warn  | `@mcp.omit` on a key                                                                                                     | Only query (and create) are offered                       |
| `PROMPT_NAME_CLASH`            | error | Two prompts with the same name                                                                                           | Neither is exposed                                        |
| `TOOL_NAME_CLASH`              | error | Two definitions map to one tool name (also across services)                                                              | Neither is exposed, unless one is the plugin's own        |
| `INVALID_TOOL_NAME`            | error | A tool name outside MCP's `[A-Za-z0-9._-]{1,128}` (spaces, non-ASCII, very long namespaces)                              | The tool is not exposed                                   |
| `LONG_TOOL_NAME`               | warn  | A tool name over 64 characters, which some LLM APIs reject                                                               | Exposed                                                   |
| `UNKNOWN_CONFIG`               | warn  | A misspelled `cds.mcp` key                                                                                               | Ignored                                                   |
| `INVALID_SKILL`                | warn  | A skill that breaks a Skills rule (frontmatter, name, symlink, limits), or a skills folder with none                     | That skill is not served                                  |
| `INVALID_CONFIG`               | error | A `cds.mcp` value of the wrong shape, an unreadable instructions file or skills folder, or `defaultRows` above `maxRows` | That key's default is used                                |

[docs/annotations.md](../annotations.md#diagnostics) has the exact conditions for each code.

Before you deploy, the report should have no `error` lines, and you should understand every
`warn` line.

## A tool is missing

A tool you expected is not in `tools/list`. Work down this list.

1. **Is it counted in the startup report?** If not, the model is the problem (steps 2–4). If it
   is, but your client does not see it, it is the caller (step 5).
2. **Is it opted in?** Entities and functions need `@mcp` on their service, or on themselves.
   Actions need `@mcp` on the action, even in an `@mcp` service. Create, update and delete
   need `@mcp.wrap.modes`. `@mcp: false` or `@cds.api.ignore` removes an entity and its bound
   operations. CAP-generated entities (`.texts`, `DraftAdministrativeData`) are never in the
   baseline.
3. **Is it under the name you expect?** Tools are `<Service>_<Entity>_<mode>` and
   `<Service>_<operation>` (bound: `<Service>_<Entity>_<operation>`), with the service's
   namespace dropped and dots as `_`. In an `@mcp.compact` service there are no per-entity
   tools: look for `<Service>_query`, `<Service>_create`, … with the entity as an argument.
4. **Can its records be addressed?** `get`, `update`, `delete` and bound operations need the
   entity's keys. An entity without keys, or with an `@mcp.omit` key, offers only query (and
   create): see `OMITTED_KEY` and `BOUND_OPERATION_WITHOUT_KEYS`.
5. **Can this user call it?** `tools/list` leaves out tools CAP would always refuse for the
   caller: `@requires` on the service, entity or operation, and the roles of `@restrict` grants
   (`READ` for query and get, `CREATE` / `UPDATE` / `DELETE` or `WRITE` for writes, the
   operation's name for operations). Compare with OData as the same user: if
   `GET /odata/v4/catalog/Books` is a 403 for them, the tool is hidden for them too. Check the
   roles your token actually carries.

Example: this exposes `CatalogService_Books_query`, `_get` and `_update`, and the action
`CatalogService_restock`.

```cds
@mcp service CatalogService {
  entity Books { key ID : Integer; stock : Integer; }
  @mcp action restock(book : Integer, quantity : Integer);
}
annotate CatalogService.Books with @mcp.wrap.modes: ['update'];
```

## A skill is missing

A skill you expected is not in the client's skills list, or its `SKILL.md` is not in
`resources/list`. See [Skills](skills.md).

1. **Does the startup report list it?** The line reads
   `skills (cds.mcp.skills): N skills (skill://…/SKILL.md, …)`. No line at all means no skill
   is served: check the next steps.
2. **Is `cds.mcp.skills` set, and to the right folder?** It is a folder relative to the app
   root, holding one folder per skill. A folder that does not exist, is not a folder, is
   outside the app root (also through a symlink) or is the app root itself is an
   `INVALID_CONFIG` error, and no skills are served. A misspelled key is `UNKNOWN_CONFIG`.
3. **Is there an `INVALID_SKILL` warning for it?** Its target is the file or folder under the
   skills folder, and the message says what is wrong:

   | Message says                                                | Fix                                                                     |
   | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
   | `must contain string "name" and "description"`              | Start `SKILL.md` with `---`, a `name:` and a `description:` line, `---` |
   | `frontmatter name "x" must match the last path segment "y"` | Rename the folder or the `name` so they are equal                       |
   | `must be 1-64 lowercase letters, digits and single hyphens` | Use a name like `handle-return`                                         |
   | `symlinks and other special files are not followed`         | Copy the file into the skill instead of linking it                      |
   | `exceeds the limit of 512 files / 16777216 bytes`           | Split the skill, or move large files out of it                          |
   | `no skills found`                                           | The folder has no `SKILL.md` one level down: check the layout           |

4. **Did you restart?** Skills are read once at startup.
5. **Deployed app only?** `cds build` copies only the skills the app serves, to
   `gen/srv/<folder>`; its output warns about the rest. With an explicit `build.tasks` list,
   add `{ "for": "mcp" }`.
6. **Does the client support the Skills extension?** Clients without it do not show a skills
   list, but still see each `SKILL.md` in `resources/list` and can read every file.

After startup, a warning `cap-mcp: skill file …` means a file changed on disk or could not be
read since it was loaded: the client gets an error for that file. Restart to load the new
content.

## Requests fail

| You see                                                                   | Why                                                                                                                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401 with `WWW-Authenticate: Basic`                                   | Mocked or basic auth, and the credentials are missing or wrong (or production requires a login, see below)                                                       |
| HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…"`            | OAuth-based auth (XSUAA, IAS, JWT) without a valid token. The client should read the metadata URL and log in; see [Authentication and production](production.md) |
| HTTP 401 for anonymous callers in production, even for `@requires: 'any'` | CAP's `restrict_all_services` default applies to `/mcp` too when `NODE_ENV=production`                                                                           |
| HTTP 403 `Origin … is not allowed`                                        | A browser request whose origin is not in `cds.mcp.allowedOrigins` (your app's own origin too). List browser-based clients there                                  |
| HTTP 405 on GET or DELETE                                                 | The server is stateless: there are no SSE streams or sessions to open or close. Clients fall back to POST                                                        |
| JSON-RPC error `-32022` (unsupported protocol version)                    | The client speaks a protocol version the SDK does not serve (supported: 2026-07-28 and 2025-11-25 back to 2024-11-05)                                            |
| Tool error `CONFIRMATION_REQUIRED`                                        | An `@mcp.elicit` operation, called by a client that cannot ask the user (2025-era, or no `elicitation` capability)                                               |
| Tool error "Input validation error" or `INVALID_ARGUMENT`                 | The arguments do not fit the tool's input schema, or name a field, value or entity the tool cannot act on. The message names the argument                        |
| Tool error with a CAP code (`ASSERT_MANDATORY`, your own codes)           | CAP or your handler rejected the call, exactly as over OData. Nothing was committed                                                                              |
| "Internal error"                                                          | An unexpected error (a failed commit, a bug). Its text reaches clients only outside production (`NODE_ENV=production`); check the server log                     |

## More logs

Turn on debug logs for the plugin with `DEBUG=mcp cds watch`, or in your cds config:

```json
{ "cds": { "log": { "levels": { "mcp": "debug" } } } }
```

Then call `tools/list` from the MCP Inspector (`npx @modelcontextprotocol/inspector`) as the user
in question.
