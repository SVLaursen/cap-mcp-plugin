# Resources, prompts, confirmation and completion

Each of these is opt-in with its own annotation. The examples come from the demo bookshop in
this repository (`demo/srv/*.cds`).

## Resources: single records by key

Tools do the querying. A resource is one record, read by key, that a client can keep in its
context or a user can attach to a conversation.

```cds
service AdminService {
  /** Authors, also exposed as single-record resources. */
  @mcp.resource
  entity Authors { key ID : Integer; name : String; email : String @mcp.omit; }
}
annotate AdminService with @mcp;
```

- The entity offers the resource template `cap://AdminService/Authors/{key}`, and
  `resources/read` of `cap://AdminService/Authors/101` returns that author as one
  `application/json` content, without omitted fields. A missing record is MCP's
  resource-not-found error.
- The key segment is the key's value, or `k1=v1;k2=v2` for several keys, URI-encoded.
- Query and get results for the entity carry a `resource_link` to each record they return, so
  a client can follow up with `resources/read`.
- `resources/list` lists no records, only the templates (and MCP App UIs, see
  [MCP Apps](mcp-apps.md)). A caller sees the template only if CAP lets them read the entity.
- The read goes through CAP like a `get` call: `@restrict` and your `READ` handlers apply.

`@mcp.resource` does not expose the entity by itself: it needs `@mcp` on the service or the
entity.

## Prompts

Prompts are reusable instructions the user picks in the client.

```cds
@mcp
@mcp.prompts: [{
  name       : 'restock-plan',
  title      : 'Restock plan',
  description: 'Suggest which books to restock, based on current stock levels',
  template   : 'List books with stock below {{threshold}} and suggest a restock quantity for each.',
  role       : 'user',
  inputs     : [{ key: 'threshold', type: 'Integer' }]
}]
service AdminService { entity Books { key ID : Integer; stock : Integer; } }
```

- `name` and `template` are required; `role` is `user` (default) or `assistant`.
- Each `inputs` entry is a required argument. `{{key}}` in the template is replaced by its value.
  Arguments travel as strings, so an `Integer` or `Decimal` input must look like a number and a
  `Boolean` one is `true` or `false`.
- A prompt is listed to callers who can reach its service (its `@requires`).
- Prompt names are global: two prompts with the same name (in any services) are both left out
  (`PROMPT_NAME_CLASH`).

## Confirmation: `@mcp.elicit`

Ask the user before an operation runs. The client shows a form; nothing runs until the user
accepts.

```cds
service OrdersService {
  entity Orders { key ID : UUID; status : String; }
    actions {
      /** Cancel an order. Asks the user to confirm first. */
      @mcp @mcp.elicit: ['confirm']
      action cancel(reason : String) returns Orders;
    };
}
annotate OrdersService with @mcp;
```

- `['confirm']` asks for a yes. A list of parameter names (`@mcp.elicit: ['reason']`) also
  shows those parameters in the form, pre-filled with the agent's values; the user's answers
  replace them. Parameters a form cannot hold (arrays, structures) keep the agent's value.
- It uses MCP 2026-07-28's multi round-trip requests: the server answers the call with
  `input_required` and a form, and the client retries the same call with the user's answer.
  The answer only counts for the exact call the form was about (same tool, arguments and user).
- Decline or cancel gives a `CONFIRMATION_DECLINED` tool error.
- Clients that cannot ask the user (2025-era clients, or clients without the `elicitation`
  capability) get a `CONFIRMATION_REQUIRED` tool error that says why. The call never runs
  unconfirmed.

Confirmation is a safety net for the user, not authorization: a client could fake an answer.
Who may call the operation at all is still CAP's `@requires` / `@restrict`.

## Completion: `@mcp.completion`

```cds
service AdminService {
  @mcp.resource
  entity Authors { key ID : Integer @mcp.completion; name : String; }
}
annotate AdminService with @mcp;
```

A client that sends `completion/complete` for the template `cap://AdminService/Authors/{key}`
gets the keys that start with what the user typed, in key order, as the caller may read them
(CAP applies `@restrict`): at most 100 values, with `hasMore` when there are more.

MCP completes resource-template variables and prompt arguments only; it has no completion for
tool arguments. So `@mcp.completion` works on the single key of an `@mcp.resource` entity, and
anywhere else it has no effect (`UNUSED_ANNOTATION` at startup).

## Model description: `@mcp.describe`

```cds
@mcp @mcp.describe
service CatalogService { entity Books { key ID : Integer; title : String; } }
```

Adds a `CatalogService_describe` tool (optional argument `entity`) that describes the service's
entities, fields, keys and operations, limited to what the caller can reach. It publishes the
shape of your model to agents, so it is off unless you add it.

## Compact mode: `@mcp.compact`

```cds
@mcp @mcp.compact
service AdminService {
  @mcp.wrap.modes: ['create', 'update', 'delete']
  entity Books { key ID : Integer; title : String; }
  entity Authors { key ID : Integer; name : String; }
}
```

Instead of tools per entity and operation, the service gets one generic set:
`AdminService_list_entities`, `_describe_entity`, `_query`, `_get`, `_create`, `_update`,
`_delete` and `_call_operation`. Each takes the entity (or operation) as an argument, limited to
what that tool may act on; write tools appear only when some entity allows them. Use it for
large services, where hundreds of tools would crowd the agent's context. Operations with
`@mcp.ui` keep their own tool, so hosts can show their UI.
